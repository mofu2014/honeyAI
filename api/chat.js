// api/chat.js
// 複数のキーを使って、エラーを絶対に出さない「不死身の構成」

export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();

    // ★ここにVercelに設定したキーを全部書く（なければ無視されるので多めに書いてOK）
    const serverKeys = [
      process.env.SAMBANOVA_API_KEY,  // メイン
      process.env.API_KEY_1,          // サブ1
      process.env.API_KEY_2,          // サブ2
      process.env.API_KEY_3           // サブ3
    ].filter(k => k); // 空のやつを除外

    // ユーザーキーがある場合はそれだけを使う（最強）
    // ない場合は、サーバーキーのリストを使う
    let keysToTry = userApiKey ? [userApiKey] : serverKeys;

    if (keysToTry.length === 0) {
      return new Response(JSON.stringify({ error: "APIキーが1つも設定されていません" }), { status: 500 });
    }

    // キーをシャッフル（ランダム）にして負荷を散らす
    if (!userApiKey) {
        keysToTry = keysToTry.sort(() => Math.random() - 0.5);
    }

    // ★隠し性格（維持）
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

    // ★ここからが「不死身ループ」
    // キーの数だけ挑戦する。どれか一つでも成功すればOK。
    let lastError = null;

    for (const apiKey of keysToTry) {
        try {
            console.log(`Trying with key: ...${apiKey.slice(-4)}`); // ログ確認用

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
                    model: "Meta-Llama-3.1-70B-Instruct",
                    stream: true,
                    temperature: 0.6,
                    max_tokens: parseInt(maxTokens) || 4096
                }),
            });

            // 成功したら（200 OK）、ストリームを開始して終了！
            if (response.ok) {
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
                // 失敗した場合（429 Rate Limitなど）
                const errText = await response.text();
                console.warn(`Key failed (${response.status}): ${errText}`);
                lastError = { status: response.status, message: errText };
                
                // 429 (Too Many Requests) なら、次のキーへGO！
                // それ以外の致命的なエラー（401認証エラーなど）も、念のため次のキーを試す
                continue; 
            }

        } catch (e) {
            console.error("Network Error:", e);
            lastError = { status: 500, message: e.message };
            continue; // 次のキーへ
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
