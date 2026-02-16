// api/chat.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, userApiKey } = await req.json();

    // 1. 全キーを収集し、プロバイダー情報を紐付け
    const keyPool = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, type: 'groq' },
      { key: process.env.GEMINI_API_KEY, type: 'gemini' }
    ].filter(item => item.key);

    // 試行順序をランダム化（負荷分散）
    let providersToTry = userApiKey 
      ? [{ key: userApiKey, type: userApiKey.startsWith('gsk_') ? 'groq' : 'sambanova' }] 
      : keyPool.sort(() => Math.random() - 0.5);

    // 2. 隠し性格の定義
    const hiddenRules = ` 一人称は「私」。名乗らずに会話を開始してください。メタ発言、AIである言及は禁止。重要な箇所は**太字**、強調は<span style="color:red">赤色</span>を使用してください。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // 3. プロバイダーを渡り歩くループ
    for (const provider of providersToTry) {
      try {
        let apiUrl, body, headers = { "Content-Type": "application/json" };

        if (provider.type === 'gemini') {
          // --- Geminiの設定 ---
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.content }]
            })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: parseInt(maxTokens) || 4096 }
          };
        } else {
          // --- OpenAI互換 (SambaNova / Groq) の設定 ---
          apiUrl = provider.type === 'groq' 
            ? "https://api.groq.com/openai/v1/chat/completions" 
            : "https://api.sambanova.ai/v1/chat/completions";
          
          headers["Authorization"] = `Bearer ${provider.key}`;
          body = {
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct",
            stream: true,
            temperature: 0.7,
            max_tokens: parseInt(maxTokens) || 4096
          };
        }

        const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body) });

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
                  // Geminiのストリーム解析 (JSONパーツからtextを抽出)
                  const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                  if (matches) {
                    matches.forEach(m => {
                      const t = JSON.parse(`{${m}}`).text;
                      controller.enqueue(encoder.encode(t));
                    });
                    buffer = ""; // Geminiはチャンクごとに完結しやすいのでクリア
                  }
                } else {
                  // OpenAI形式 (Groq/Samba) のストリーム解析
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
          lastError = `Provider ${provider.type} failed (${response.status})`;
          continue; // 失敗したら次の会社（プロバイダー）へ！
        }
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }

    return new Response(JSON.stringify({ error: `すべてのAIプロバイダーが制限中です。1分ほど待ってね。 詳細: ${lastError}` }), { status: 429 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
