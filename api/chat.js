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

    // --- 2. 厳格なモード分け（fallbackさせない） ---
    let providersToTry = [];
    if (selectedMode === 'gemini') {
        // GeminiモードならGeminiしか入れない！
        providersToTry = geminiPool.sort(() => Math.random() - 0.5);
    } else if (selectedMode === 'llama') {
        // LlamaモードならLlamaしか入れない！
        providersToTry = llamaPool.sort(() => Math.random() - 0.5);
    } else {
        // 自動モードならGemini優先で混ぜる
        providersToTry = [...geminiPool.sort(() => Math.random() - 0.5), ...llamaPool.sort(() => Math.random() - 0.5)];
    }

    if (providersToTry.length === 0) return new Response(JSON.stringify({ error: "APIキーが見つかりません" }), { status: 500 });

    const hiddenRules = ` 一人称「私」。名乗らない。装飾：重要は**太字**、強調は<span style="color:red">赤色</span>。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // --- 3. リトライループ ---
    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); 

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // Google公式ドキュメントに準拠したURL形式
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 8192 }
          };
        } else {
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          const modelName = provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct";
          body = { messages: [{ role: "system", content: finalSystemPrompt }, ...messages], model: modelName, stream: true, temperature: 0.7, max_tokens: parseInt(maxTokens) || 4096 };
        }

        const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
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
                if (provider.type === 'gemini') {
                  // Geminiのストリームは [{...}] の形式。textを正規表現で抜き出す
                  const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                  if (matches) {
                    matches.forEach(m => {
                      try { const t = JSON.parse(`{${m}}`).text; controller.enqueue(new TextEncoder().encode(t)); } catch(e){}
                    });
                    buffer = ""; 
                  }
                } else {
                  const lines = buffer.split("\n");
                  buffer = lines.pop();
                  for (const line of lines) {
                    if (line.startsWith("data: ") && line !== "data: [DONE]") {
                      try { const content = JSON.parse(line.substring(6)).choices[0]?.delta?.content || ""; if (content) controller.enqueue(new TextEncoder().encode(content)); } catch (e) {}
                    }
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream" } });
        } else {
          // エラー内容を保持
          const rawErr = await response.text();
          lastError = `${provider.name} (${response.status}): ${rawErr}`;
          continue; 
        }
      } catch (e) {
        lastError = `${provider.name} Exception: ${e.message}`;
        continue;
      }
    }
    // 全滅したら最後のエラーをハッキリ出す
    return new Response(JSON.stringify({ error: `選択されたAI回線が全滅したみつ。原因: ${lastError}` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
