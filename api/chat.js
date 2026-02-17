// api/chat.js
export const config = { runtime: "edge" };

// レート制限を回避するためのダミーIP生成
function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    // 1. 全てのキーをプールに投入
    let allKeys = [
      { key: process.env.GEMINI_API_KEY, type: 'gemini', name: 'Gemini Main' },
      { key: process.env.GROQ_API_KEY, type: 'groq', name: 'Groq Llama' },
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova', name: 'SambaNova 1' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova', name: 'SambaNova 2' }
    ].filter(item => item.key);

    // GEMINI_KEY_1 ～ 50 を自動スキャン
    for (let i = 1; i <= 50; i++) {
        const k = process.env[`GEMINI_KEY_${i}`];
        if (k) allKeys.push({ key: k, type: 'gemini', name: `Gemini ${i}` });
    }

    // モード選択によるフィルタリング
    let providersToTry = [];
    if (selectedMode === 'gemini') {
      providersToTry = allKeys.filter(k => k.type === 'gemini');
    } else if (selectedMode === 'llama') {
      providersToTry = allKeys.filter(k => k.type === 'sambanova' || k.type === 'groq');
    } else {
      providersToTry = allKeys;
    }

    // 負荷分散のためにランダムシャッフル
    providersToTry = providersToTry.sort(() => Math.random() - 0.5);

    const hiddenRules = `一人称「私」。名乗るの禁止。メタ発言禁止。重要な所は**太字**、強調は<span style="color:red">赤色</span>。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // 2. キーを高速で試し打ちするループ
    for (const provider of providersToTry) {
      // タイムアウトを短めに設定（ダメなキーを早く見切るため）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); 

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // ★修正ポイント: v1betaではなく「v1」エンドポイントを使用（404が出にくい）
          apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.content }]
            })),
            // v1でもsystem_instructionをサポート
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
                    const l = line.trim();
                    if (l.startsWith("data: ") && l !== "data: [DONE]") {
                      try { const content = JSON.parse(l.substring(6)).choices[0]?.delta?.content || ""; if (content) controller.enqueue(new TextEncoder().encode(content)); } catch (e) {}
                    }
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream" } });
        } else {
          const errRaw = await response.text();
          lastError = `${provider.name} (${response.status}): ${errRaw.substring(0, 100)}`;
          // 404, 403, 429などが出たら、即座に次のキーを試す
          console.warn(`Skipping key due to error: ${lastError}`);
          continue; 
        }
      } catch (e) {
        lastError = `${provider.name} error: ${e.message}`;
        continue;
      }
    }
    return new Response(JSON.stringify({ error: `全AI回線がエラーまたは制限中です。少し待ってね。`, debug: lastError }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
