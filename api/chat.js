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
        geminiPool.push({ key: process.env[key], name: key, type: 'gemini' });
      }
    });

    let llamaPool = [
      { key: process.env.SAMBANOVA_API_KEY, name: 'SambaNova 1', type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, name: 'SambaNova 2', type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, name: 'Groq Llama', type: 'groq' }
    ].filter(k => k.key);

    let providersToTry = [];
    if (selectedMode === 'gemini') {
        providersToTry = geminiPool.sort(() => Math.random() - 0.5);
    } else if (selectedMode === 'llama') {
        providersToTry = llamaPool.sort(() => Math.random() - 0.5);
    } else {
        // 自動モード：Geminiを優先的に試す
        providersToTry = [...geminiPool.sort(() => Math.random() - 0.5), ...llamaPool];
    }

    const hiddenRules = ` 一人称は「私」。名乗らず会話開始。装飾:重要箇所は**太字**、強調は<span style="color:red">赤色</span>。`;
    const finalSystemPrompt = (systemPrompt || "優しく親切に話してください。") + "\n\n" + hiddenRules;

    let lastError = "";

    // 3. 不屈のダブル・リトライループ
    for (const provider of providersToTry) {
      // 1つのキーに対して「Google標準形式」と「OpenAI形式」の両方を試す
      const apiConfigs = [];
      if (provider.type === 'gemini') {
          // Geminiは2つの形式を試す
          apiConfigs.push({
              url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`,
              format: 'google',
              body: {
                contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
                system_instruction: { parts: [{ text: finalSystemPrompt }] },
                generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 8192 }
              }
          });
          apiConfigs.push({
              url: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?api_key=${provider.key}`,
              format: 'openai',
              body: {
                model: "gemini-1.5-flash",
                messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
                stream: true,
                max_tokens: parseInt(maxTokens) || 4096
              }
          });
      } else {
          // Llama(Groq/Samba)はOpenAI形式のみ
          apiConfigs.push({
              url: provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions",
              format: 'openai',
              headers: { "Authorization": `Bearer ${provider.key}` },
              body: {
                model: provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct",
                messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
                stream: true,
                max_tokens: parseInt(maxTokens) || 4000
              }
          });
      }

      for (const config of apiConfigs) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 7000); // 7秒で見切り

          const response = await fetch(config.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP(), ...(config.headers || {}) },
            body: JSON.stringify(config.body),
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
                  
                  if (config.format === 'google') {
                    // Google形式のテキスト抽出
                    const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                    if (matches) {
                      matches.forEach(m => { try { const t = JSON.parse(`{${m}}`).text; controller.enqueue(new TextEncoder().encode(t)); } catch(e){} });
                      buffer = "";
                    }
                  } else {
                    // OpenAI形式のテキスト抽出
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
            lastError = `${provider.name} (${response.status})`;
            continue; // この形式がダメなら次へ
          }
        } catch (e) {
          lastError = `${provider.name}: ${e.message}`;
          continue;
        }
      }
    }
    return new Response(JSON.stringify({ error: `全AI回線がエラーだみつ。原因: ${lastError}` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
