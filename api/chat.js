// api/chat.js
export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();

    // 1. キー・プールの構築 (2個のSambaNovaキー)
    const serverKeys = [
      process.env.SAMBANOVA_API_KEY,
      process.env.SAMBANOVA_API_KEY_2
    ].filter(k => k && k.trim() !== "");

    // ユーザーキーがある場合はそれを最優先、なければサーバーキーをシャッフル
    let currentKeys = userApiKey ? [userApiKey] : serverKeys.sort(() => Math.random() - 0.5);

    if (currentKeys.length === 0) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません。" }), { status: 500 });
    }

    // 2. 隠し性格の定義 (自然な会話 + 強制装飾)
    const hiddenRules = `
読みやすく親切な回答を心がけてください。 【装飾ルール（絶対厳守）】 - 重要な部分は **太字** にしてください。 - 強調したい部分は <span style="color:red">赤色</span> や <span style="color:orange">オレンジ色</span> を使ってください。 - 見出しが必要な場合は # を使って大きく書いてください。 - 手順などは箇条書き（- ）で見やすくしてください。 【キャラクター・行動ルール（絶対厳守）】 - 一人称は「私」です。 - メタい発言（AIとしての仕様の言及など）は禁止です。 - **「私はハチミツの妖精HoneyAIです」といった自己紹介は、聞かれない限り絶対にしないでください。** - 「私は親切です」「丁寧に対応します」といった、自分の態度への言及もしないでください。行動で示してください。 - 絶対に変なこと（不快、性的、暴力的、意味不明なこと）は言わないでください。 【会話の理想例】 ユーザー: こんにちは あなた: こんにちは！私は今日何をすればいいですか？いつでも話を聞きますよ。どんなことでも聞いてあげますから、気軽に話してくださいね！
`;
    const finalSystemPrompt = `${systemPrompt}\n\n${hiddenRules}`;

    let lastError = null;

    // 3. リトライループ (キーを順番に試す)
    for (const apiKey of currentKeys) {
      try {
        const response = await fetch("https://api.sambanova.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: "Meta-Llama-3.3-70B-Instruct",
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          }),
        });

        // 成功(200)ならストリームを返す
        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();

          return new Response(new ReadableStream({
            async start(controller) {
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                  if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                      const json = JSON.parse(line.substring(6));
                      const content = json.choices[0]?.delta?.content || "";
                      if (content) controller.enqueue(encoder.encode(content));
                    } catch (e) {}
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }

        // 失敗時 (429等) はログを残して次のキーへ
        const errText = await response.text();
        lastError = { status: response.status, text: errText };
        console.warn(`Key failed (${response.status}). Trying next...`);
        continue;

      } catch (e) {
        lastError = { status: 500, text: e.message };
        continue;
      }
    }

    // すべてのキーが全滅した場合
    return new Response(JSON.stringify({ 
      error: "現在みんなで蜜を分け合っていて、一時的にキーが制限されています。1分ほど待ってから再度送ってみてね！" 
    }), { status: 429 });

  } catch (globalError) {
    return new Response(JSON.stringify({ error: globalError.message }), { status: 500 });
  }
}
