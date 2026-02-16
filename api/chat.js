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

    // Vercelに設定したキーたちを全部リストにする
    const serverKeys = [
      process.env.SAMBANOVA_API_KEY,
      process.env.API_KEY_1,
      process.env.API_KEY_2,
      process.env.API_KEY_3
    ].filter(k => k); // 空っぽのキーは除外

    // ユーザーのキーがあればそれだけ、なければサーバーのキー全部を使う
    let keysToTry = userApiKey ? [userApiKey] : serverKeys;

    if (keysToTry.length === 0) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません" }), { status: 500 });
    }

    // ランダムに並び替えて、みんなが違うキーを使うようにする（負荷分散）
    if (!userApiKey) {
        keysToTry = keysToTry.sort(() => Math.random() - 0.5);
    }

    // 隠し性格
    const hiddenRules = `
読みやすく親切な回答を心がけてください。
【装飾ルール】
- 重要な部分は **太字** にしてください。
- 強調したい部分は <span style="color:red">赤色</span> や <span style="color:orange">オレンジ色</span> を使ってください。
- 見出しが必要な場合は # を使って大きく書いてください。
- 手順などは箇条書き（- ）で見やすくしてください。
【キャラクター・行動ルール】
- 一人称は「私」です。
- メタい発言は禁止です。
- 「私はハチミツの妖精HoneyAIです」といった自己紹介は、聞かれない限りしないでください。
- 絶対に変なことは言わないでください。
`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // キーを順番に試していく「不死身ループ」
    for (const apiKey of keysToTry) {
        try {
            console.log(`Trying API Key...`);

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
                    // ★ここを最新モデルに変更しました！
                    model: "Meta-Llama-3.3-70B-Instruct",
                    stream: true,
                    temperature: 0.6,
                    max_tokens: parseInt(maxTokens) || 4096
                }),
            });

            if (response.ok) {
                // 成功したらストリームを開始して終了
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
            } else {
                // エラーが出たら次のキーへ
                const errText = await response.text();
                console.warn(`Key failed: ${errText}`);
                lastError = { status: response.status, message: errText };
                continue; 
            }

        } catch (e) {
            console.error("Network Error:", e);
            lastError = { status: 500, message: e.message };
            continue;
        }
    }

    // 全部失敗した場合
    return new Response(JSON.stringify({ 
        error: `全APIキーがダウン中だみつ... (Last Error: ${lastError?.message})` 
    }), { status: lastError?.status || 500 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
