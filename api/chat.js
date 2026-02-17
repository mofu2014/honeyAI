// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    let allKeys = [
      { key: process.env.GEMINI_API_KEY, type: 'gemini', name: 'Gemini Main' },
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova', name: 'SambaNova 1' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova', name: 'SambaNova 2' },
      { key: process.env.GROQ_API_KEY, type: 'groq', name: 'Groq Llama' }
    ].filter(item => item.key);

    for (let i = 1; i <= 50; i++) {
        const k = process.env[`GEMINI_KEY_${i}`];
        if (k) allKeys.push({ key: k, type: 'gemini', name: `Gemini ${i}` });
    }

    let providersToTry = [];
    if (selectedMode === 'gemini') {
      providersToTry = allKeys.filter(k => k.type === 'gemini');
    } else if (selectedMode === 'llama') {
      providersToTry = allKeys.filter(k => k.type === 'sambanova' || k.type === 'groq');
    } else {
      providersToTry = allKeys;
    }

    // 負荷分散のためのシャッフル
    providersToTry = providersToTry.sort(() => Math.random() - 0.5);

    const hiddenRules = ` 一人称「私」。名乗るの禁止。メタ発言禁止。装飾：重要は**太字**、強調は<span style="color:red">赤色</span>。語尾「〜だみつ」。`;
    const finalSystemPrompt = (systemPrompt || "あなたはハチミツの妖精です。") + "\n\n" + hiddenRules;

    let lastError = null;

    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // ★ v1betaに戻し、モデル名を最新の「gemini-1.5-flash-latest」に変更して404を回避
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.content }]
            })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 8192 }
          };
        } else {
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          const modelName = provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct";
          body = {
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: modelName,
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          };
        }

        const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const reader = response.body.getReader();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();

          return new Response(new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(`[:model:${provider.name}:]`));
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
                        controller.enqueue(encoder.encode(t));
                      } catch(e){}
                    });
                    buffer = "";
                  }
                } else {
                  const lines = buffer.split("\n");
                  buffer = lines.pop();
                  for (const line of lines) {
                    const l = line.trim();
                    if (l.startsWith("data: ") && l !== "data: [DONE]") {
                      try {
                        const content = JSON.parse(l.substring(6)).choices[0]?.delta?.content || "";
                        if (content) controller.enqueue(encoder.encode(content));
                      } catch (e) {}
                    }
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        } else {
          const errRaw = await response.text();
          lastError = `${provider.name} (${response.status}): ${errRaw}`;
          continue; 
        }
      } catch (e) {
        lastError = `${provider.name} Exception: ${e.message}`;
        continue;
      }
    }
    return new Response(JSON.stringify({ error: `全AI回線でエラーが発生中だみつ。\n【詳細】${lastError}` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
