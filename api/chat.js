// api/chat.js
export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();
    
    // ユーザーキーがあれば優先、なければサーバーのSambaNovaキーを使う
    // ※SambaNovaは現在無料プレビュー中で制限がかなり緩いので、サーバーキー1つでも30人程度なら余裕で耐えます
    const apiKey = userApiKey || process.env.SAMBANOVA_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキー(SAMBANOVA_API_KEY)が設定されていません" }), { status: 500 });
    }

    // ★隠し性格（裏ルール）をここに定義
    const hiddenRules = `
読みやすく親切な回答を心がけてください。

【装飾ルール（絶対厳守）】
- 重要な部分は **太字** にしてください。
- 強調したい部分は <span style="color:red">赤色</span> や <span style="color:orange">オレンジ色</span> を使ってください。
- 見出しが必要な場合は # を使って大きく書いてください。
- 手順などは箇条書き（- ）で見やすくしてください。

【キャラクター・行動ルール（絶対厳守）】
- 一人称は「私」です。
- メタい発言（AIとしての仕様の言及など）は禁止です。
- **「私はハチミツの妖精HoneyAIです」といった自己紹介は、聞かれない限り絶対にしないでください。**
- 「私は親切です」「丁寧に対応します」といった、自分の態度への言及もしないでください。行動で示してください。
- 絶対に変なこと（不快、性的、暴力的、意味不明なこと）は言わないでください。

【会話の理想例】
ユーザー: こんにちは
あなた: こんにちは！私は今日何をすればいいですか？いつでも話を聞きますよ。どんなことでも聞いてあげますから、気軽に話してくださいね！
`;

    // ユーザー設定と隠しルールを合体
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    // ★ここをGroqからSambaNovaに変更しました
    const response = await fetch("https://api.sambanova.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: finalSystemPrompt },
          ...messages
        ],
        // SambaNovaで使える最強モデル（Llama 3.1 70B）を指定
        model: "Meta-Llama-3.1-70B-Instruct",
        stream: true,
        temperature: 0.6,
        max_tokens: parseInt(maxTokens) || 4096
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return new Response(JSON.stringify(errorData), { status: response.status });
    }

    // ストリーミング処理（Groq/OpenAIと同じ形式なのでそのまま使えます）
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = ""; 
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); 

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
              try {
                const json = JSON.parse(trimmed.substring(6));
                const content = json.choices[0]?.delta?.content || "";
                if (content) controller.enqueue(encoder.encode(content));
              } catch (e) { }
            }
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
