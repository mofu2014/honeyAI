// api/chat.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens } = await req.json();

    const keyPool = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, type: 'groq' },
      { key: process.env.GEMINI_API_KEY, type: 'gemini' }
    ].filter(item => item.key);

    let providersToTry = keyPool.sort(() => Math.random() - 0.5);

    // ★長文を書かせるための「限界突破」隠しルール
    const hiddenRules = `
【最優先指令：限界突破長文生成】
1. 回答を絶対に短くまとめないでください。
2. 関連する情報はすべて網羅し、1つの項目に対して最低でも3段落以上の詳細な解説を行ってください。
3. 専門用語、歴史的背景、具体例、メリット・デメリット、今後の展望などを徹底的に深掘りしてください。
4. ユーザーが「一言で」と言わない限り、あなたは常に数千文字規模の「論文級」の詳細さを目指して執筆してください。
5. 装飾ルール：重要な所は **太字**、強調は <span style="color:red">赤色</span> を多用して、長文でも読みやすくしてください。
6. 一人称は「私」。名乗らず、挨拶も最小限に、即座に圧倒的な密度の解説を開始してください。
`;

    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;
    let lastError = null;

    for (const provider of providersToTry) {
      const controller = new AbortController();
      // 長文生成は時間がかかるため、タイムアウトを15秒に延長
      const timeoutId = setTimeout(() => controller.abort(), 15000); 

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json" };

        if (provider.type === 'gemini') {
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            system_instruction: { parts: [{ text: finalSystemPrompt }] },
            generationConfig: { temperature: 0.8, maxOutputTokens: parseInt(maxTokens) || 8192 }
          };
        } else {
          apiUrl = provider.type === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.sambanova.ai/v1/chat/completions";
          headers["Authorization"] = `Bearer ${provider.key}`;
          body = {
            messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
            model: provider.type === 'groq' ? "llama-3.3-70b-versatile" : "Meta-Llama-3.3-70B-Instruct",
            stream: true,
            temperature: 0.8,
            // ★API側が許容する最大値を指定
            max_tokens: parseInt(maxTokens) || 8192 
          };
        }

        const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
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
    return new Response(JSON.stringify({ error: `全AIが多忙です。(${lastError})` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
