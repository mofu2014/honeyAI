// api/chat.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();

    // 1. 全プロバイダーのプール作成
    const keyPool = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, type: 'groq' },
      { key: process.env.GEMINI_API_KEY, type: 'gemini' }
    ].filter(item => item.key);

    // 試行順をランダム化して負荷分散（ユーザーキーがあれば最優先）
    let providersToTry = userApiKey 
      ? [{ key: userApiKey, type: userApiKey.startsWith('gsk_') ? 'groq' : 'sambanova' }] 
      : keyPool.sort(() => Math.random() - 0.5);

    // 2. 隠し性格の定義（裏ルール）
    const hiddenRules = `
[SYSTEM_RULE]
- 一人称: 私
- 装飾: 重要箇所は **太字**、強調は <span style="color:red">赤色</span>。見出しは #。
- 禁止: 自己紹介（ハチミツの妖精HoneyAIです等の名乗り）、自身の態度への言及。
- 口調: 自然な会話を優先し、AIらしさを隠すこと。
`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // 3. プロバイダーを渡り歩くリトライループ
    for (const provider of providersToTry) {
      // 1つの会社が6秒以上黙ったら見切って次へ
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json" };

        if (provider.type === 'gemini') {
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 4096 }
          };
        } else {
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          body = {
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct",
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          };
        }

        const response = await fetch(apiUrl, { 
          method: "POST", 
          headers, 
          body: JSON.stringify(body),
          signal: controller.signal 
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();

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
          }), { headers: { "Content-Type": "text/event-stream" } });
        } else {
          lastError = `${provider.type}: ${response.status}`;
          continue;
        }
      } catch (e) {
        lastError = `${provider.type}: ${e.name === 'AbortError' ? 'Timeout' : e.message}`;
        continue;
      }
    }

    return new Response(JSON.stringify({ error: `全プロバイダーが応答しませんでした (${lastError})` }), { status: 429 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
