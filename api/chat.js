// api/chat.js
export const config = { runtime: "edge" };

// IP制限回避用のランダムIP生成
function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();

    // --- 1. APIキープールの構築 ---
    let keyPool = [];

    // GeminiキーをGEMINI_KEY_1～50まで自動収集
    if (process.env.GEMINI_API_KEY) keyPool.push({ key: process.env.GEMINI_API_KEY, type: 'gemini' });
    for (let i = 1; i <= 50; i++) {
        const k = process.env[`GEMINI_KEY_${i}`];
        if (k) keyPool.push({ key: k, type: 'gemini' });
    }

    // Groq / SambaNova キーの追加
    const backups = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, type: 'groq' }
    ].filter(item => item.key);
    keyPool = [...keyPool, ...backups];

    // 試行順をランダム化（負荷分散）
    let providersToTry = userApiKey 
      ? [{ key: userApiKey, type: userApiKey.startsWith('AIza') ? 'gemini' : (userApiKey.startsWith('gsk_') ? 'groq' : 'sambanova') }] 
      : keyPool.sort(() => Math.random() - 0.5);

    if (providersToTry.length === 0) return new Response(JSON.stringify({ error: "APIキーが設定されていません" }), { status: 500 });

    // --- 2. 隠し性格の強制注入 ---
    const hiddenRules = `
[SYSTEM: STRICT RULES]
- 一人称は「私」です。
- 語尾に「〜だみつ」「〜ハニー」をつけてください。
- 重要な箇所は **太字**、強調は <span style="color:red">赤色</span> を使用。
- 自己紹介（ハチミツの妖精です、等）は一切禁止。名乗らず会話を開始してください。
- 自分の態度（親切、丁寧等）への言及も禁止。
- メタ発言（AIとしての仕様、モデル名など）は厳禁。
- 理想: 「こんにちは！今日は何かお手伝いできることはありますか？」
`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // --- 3. 不屈のリトライループ ---
    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒で次へ

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 8192 }
          };
        } else {
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          const modelName = provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.1-8B-Instruct";
          body = {
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: modelName, stream: true, temperature: 0.7, max_tokens: parseInt(maxTokens) || 4096
          };
        }

        const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          return new Response(new ReadableStream({
            async start(controller) {
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (provider.type === 'gemini') {
                  const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                  if (matches) {
                    matches.forEach(m => { try { const t = JSON.parse(`{${m}}`).text; controller.enqueue(new TextEncoder().encode(t)); } catch(e){} });
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
          lastError = `${provider.type}: ${response.status}`;
          continue;
        }
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }
    return new Response(JSON.stringify({ error: `全回線が混雑中だみつ... (${lastError})` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
