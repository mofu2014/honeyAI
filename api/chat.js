// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens } = await req.json();

    // 1. 2つのアカウントをシャッフル
    const apiKeys = [
      process.env.SAMBANOVA_API_KEY,
      process.env.SAMBANOVA_API_KEY_2
    ].filter(k => k).sort(() => Math.random() - 0.5);

    // 2. 試行するモデルの優先順位 (最強 -> 高速)
    const modelHierarchy = [
      "Meta-Llama-3.1-405B-Instruct", // 天才 (5 RPM)
      "Meta-Llama-3.3-70B-Instruct",  // 秀才 (30 RPM)
      "Meta-Llama-3.1-8B-Instruct"    // 快速 (60 RPM)
    ];

    const hiddenRules = ` 一人称は「私」。名乗らない。装飾:重要は**太字**、強調は<span style="color:red">赤</span>。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // --- 3. 階層リトライ開始 ---
    for (const modelName of modelHierarchy) {
      for (const apiKey of apiKeys) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);

          const response = await fetch("https://api.sambanova.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-Forwarded-For": getRandomIP()
            },
            body: JSON.stringify({
              messages: [{ role: "system", content: finalSystemPrompt }, ...messages.slice(-15)], // 文脈を直近15件に絞ってTPM節約
              model: modelName,
              stream: true,
              temperature: 0.7,
              max_tokens: parseInt(maxTokens) || 4096
            }),
            signal: controller.signal
          });

          if (response.ok) {
            clearTimeout(timeoutId);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();

            return new Response(new ReadableStream({
              async start(controller) {
                // どのモデルが採用されたか通知
                const shortName = modelName.includes("405B") ? "405B(Ultra)" : (modelName.includes("70B") ? "70B(Pro)" : "8B(Flash)");
                controller.enqueue(encoder.encode(`[:model:${shortName}:]`));

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
                        const content = JSON.parse(line.substring(6)).choices[0]?.delta?.content || "";
                        if (content) controller.enqueue(encoder.encode(content));
                      } catch (e) {}
                    }
                  }
                }
                controller.close();
              },
            }), { headers: { "Content-Type": "text/event-stream" } });
          } else {
            // 429等のエラーなら次の「キー」または「モデル」へ
            lastError = `${modelName}: ${response.status}`;
            continue;
          }
        } catch (e) {
          lastError = e.message;
          continue;
        }
      }
    }

    return new Response(JSON.stringify({ error: "全回線パンク中だみつ！10秒待ってね。" }), { status: 429 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
