// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    // 1. 全てのキーを収集
    let geminiPool = [];
    Object.keys(process.env).forEach(key => {
      if (key.includes("GEMINI") && process.env[key]) {
        geminiPool.push({ key: process.env[key], type: 'gemini', name: key });
      }
    });

    let llamaPool = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova', name: 'SambaNova 1' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova', name: 'SambaNova 2' },
      { key: process.env.GROQ_API_KEY, type: 'groq', name: 'Groq Llama' }
    ].filter(k => k.key);

    // 2. モード選択
    let providersToTry = [];
    if (selectedMode === 'gemini') {
        providersToTry = geminiPool.sort(() => Math.random() - 0.5);
    } else if (selectedMode === 'llama') {
        providersToTry = llamaPool.sort(() => Math.random() - 0.5);
    } else {
        // 自動モード：Geminiを優先的に試す
        providersToTry = [...geminiPool.sort(() => Math.random() - 0.5), ...llamaPool];
    }

    // 隠し性格
    const hiddenRules = ` 一人称は「私」。名乗るの禁止。装飾：重要箇所は**太字**、強調は<span style="color:red">赤色</span>。語尾「〜だみつ」。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // 3. リトライループ
    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); 

      try {
        let apiUrl, modelName, headers = { 
            "Content-Type": "application/json", 
            "X-Forwarded-For": getRandomIP() 
        };

        if (provider.type === 'gemini') {
          // ★最強の修正：GeminiをOpenAI互換エンドポイントで叩く（404を回避）
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?api_key=${provider.key}`;
          modelName = "gemini-1.5-flash";
        } else if (provider.type === 'groq') {
          apiUrl = "https://api.groq.com/openai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          modelName = "llama-3.3-70b-versatile";
        } else {
          apiUrl = "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          modelName = "Meta-Llama-3.3-70B-Instruct";
        }

        const response = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          return new Response(new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(`[:model:${provider.name}:]`));
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                
                const lines = buffer.split("\n");
                buffer = lines.pop();

                for (const line of lines) {
                  const l = line.trim();
                  if (l.startsWith("data: ") && l !== "data: [DONE]") {
                    try {
                      const json = JSON.parse(l.substring(6));
                      const content = json.choices[0]?.delta?.content || "";
                      if (content) controller.enqueue(new TextEncoder().encode(content));
                    } catch (e) {}
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream" } });
        } else {
          const errRaw = await response.text();
          lastError = `${provider.name} (${response.status})`;
          continue; 
        }
      } catch (e) {
        lastError = `${provider.name}: ${e.message}`;
        continue;
      }
    }
    return new Response(JSON.stringify({ error: `全回線が全滅だみつ。原因: ${lastError}` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
