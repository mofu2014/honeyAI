// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    // 1. 環境変数のキーをすべて収集（GEMINIという文字が入っていれば全部拾う）
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

    // 実行順序の決定
    let providersToTry = [];
    if (selectedMode === 'gemini') {
        providersToTry = geminiPool.sort(() => Math.random() - 0.5);
    } else if (selectedMode === 'llama') {
        providersToTry = llamaPool.sort(() => Math.random() - 0.5);
    } else {
        // 自動モード：Gemini 17個を最優先で並べ、その後にLlamaを置く
        providersToTry = [...geminiPool.sort(() => Math.random() - 0.5), ...llamaPool];
    }

    const hiddenRules = ` 一人称は「私」。名乗らない。装飾：重要は**太字**、強調は<span style="color:red">赤色</span>。語尾「〜だみつ」。`;
    const finalSystemPrompt = (systemPrompt || "親切に話してください。") + "\n\n" + hiddenRules;

    let debugLogs = [];

    // 2. 執念のリトライループ
    for (const provider of providersToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6秒で次へ（高速化）

        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // ★404対策：URLを最も互換性の高い「v1beta」の直撃モードに変更
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          
          body = {
            contents: [
              // system_instructionが使えないプロジェクト対策として、最初の発言に命令を埋め込む「プロ仕様」の書き方
              { role: "user", parts: [{ text: `これからのルール: ${finalSystemPrompt}` }] },
              { role: "model", parts: [{ text: "了解しましただみつ！" }] },
              ...messages.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
              }))
            ],
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 8192 }
          };
        } else {
          // Llama (SambaNova / Groq)
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
                      try { const t = JSON.parse(`{${m}}`).text; controller.enqueue(new TextEncoder().encode(t)); } catch(e){}
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
          // エラーが出たら即座に次のキーへ（ユーザーには内緒でリトライ）
          const errText = await response.text();
          debugLogs.push(`${provider.name}: ${response.status}`);
          console.warn(`Key ${provider.name} failed with ${response.status}`);
          continue; 
        }
      } catch (e) {
        debugLogs.push(`${provider.name}: ${e.message}`);
        continue;
      }
    }
    // 本当に全部（20個以上）がダメだった時だけエラーを出す
    return new Response(JSON.stringify({ error: "全回線でエラーだみつ。時間を置いてね。", details: debugLogs }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
