// api/chat.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens } = await req.json();

    // サーバー側のキープール
    const keyPool = [
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova' },
      { key: process.env.GROQ_API_KEY, type: 'groq' },
      { key: process.env.GEMINI_API_KEY, type: 'gemini' }
    ].filter(item => item.key);

    // 負荷分散のためにランダムに並び替え
    let providersToTry = keyPool.sort(() => Math.random() - 0.5);

    // 隠し性格設定
    const hiddenRules = `
読みやすく親切な回答を心がけてください。
【装飾ルール（絶対厳守）】
- 重要な部分は **太字** にしてください。
- 強調したい部分は <span style="color:red">赤色</span> や <span style="color:orange">オレンジ色</span> を使ってください。
- 見出しが必要な場合は # を使って大きく書いてください。
- 手順などは箇条書き（- ）で見やすくしてください。
【キャラクター・行動ルール（絶対厳守）】
- 一人称は「私」です。
- メタい発言（AIとしての仕様の言及など）は禁止です。
- 「私はハチミツの妖精HoneyAIです」といった自己紹介は、聞かれない限り絶対にしないでください。
- 「私は親切です」「丁寧に対応します」といった、自分の態度への言及もしないでください。行動で示してください。
- 絶対に変なこと（不快、性的、暴力的、意味不明なこと）は言わないでください。
【会話の理想例】
ユーザー: こんにちは
あなた: こんにちは！私は今日何をすればいいですか？いつでも話を聞きますよ。どんなことでも聞いてあげますから、気軽に話してくださいね！`;

    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;
    let lastError = null;

    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6秒でタイムアウト

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
    return new Response(JSON.stringify({ error: `全AIが混雑中です。(${lastError})` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
