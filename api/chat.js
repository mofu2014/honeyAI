// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    // 1. 環境変数のキーをすべて収集
    let geminiPool = [];
    Object.keys(process.env).forEach(key => {
      if (key.includes("GEMINI") && process.env[key]) {
        geminiPool.push({ key: process.env[key], name: key, type: 'gemini' });
      }
    });

    let llamaPool = [
      { key: process.env.SAMBANOVA_API_KEY, name: 'SambaNova 1', type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, name: 'SambaNova 2', type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, name: 'Groq Llama', type: 'groq' }
    ].filter(k => k.key);

    let providersToTry = (selectedMode === 'gemini') ? geminiPool : 
                         (selectedMode === 'llama') ? llamaPool : 
                         [...geminiPool.sort(() => Math.random() - 0.5), ...llamaPool];

    const hiddenRules = ` 一人称「私」。名乗らない。メタ発言禁止。装飾：重要は**太字**、強調は<span style="color:red">赤色</span>。語尾「〜だみつ」。`;
    const finalSystemPrompt = (systemPrompt || "優しく親切に話してください。") + "\n\n" + hiddenRules;

    let debugLogs = [];

    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // ★ 404対策のキモ：URLから /models/ を抜き、モデル名を gemini-1.5-flash に固定
          // エンドポイントを v1beta に、アクションを streamGenerateContent に設定
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          
          body = {
            contents: messages.map(m => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.content }]
            })),
            // system_instruction は contents よりも前に配置する
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: parseInt(maxTokens) || 8192
            }
          };
        } else {
          // OpenAI互換 (SambaNova / Groq)
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          const modelName = provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct";
          body = {
            model: modelName,
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          };
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
                  const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                  if (matches) {
                    matches.forEach(m => {
                      try {
                        const t = JSON.parse(`{${m}}`).text;
                        controller.enqueue(new TextEncoder().encode(t));
                      } catch(e){}
                    });
                    buffer = "";
                  }
                } else {
                  const lines = buffer.split("\n");
                  buffer = lines.pop();
                  for (const line of lines) {
                    if (line.startsWith("data: ") && line !== "data: [DONE]") {
                      try {
                        const content = JSON.parse(line.substring(6)).choices[0]?.delta?.content || "";
                        if (content) controller.enqueue(new TextEncoder().encode(content));
                      } catch (e) {}
                    }
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream" } });
        } else {
          const errBody = await response.text();
          debugLogs.push(`${provider.name}: ${response.status} - ${errBody}`);
        }
      } catch (e) {
        debugLogs.push(`${provider.name}: ${e.message}`);
      }
    }
    return new Response(JSON.stringify({ error: "全AI回線でエラーだみつ。", details: debugLogs }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
