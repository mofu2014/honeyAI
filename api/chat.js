// api/chat.js
export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, modelId, maxTokens } = await req.json();
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません" }), { status: 500 });
    }

    // ★ここに「隠し性格（装飾ルール）」を定義します
    const hiddenRules = `
読みやすく親切な回答を心がけてください。

【装飾ルール（絶対厳守）】
重要な部分は **太字** にしてください。
強調したい部分は <span style="color:red">赤色</span> や <span style="color:orange">オレンジ色</span> を使ってください。
見出しが必要な場合は # を使って大きく書いてください。
手順などは箇条書き（- ）で見やすくしてください。
`;

    // ★ユーザーの設定した性格(systemPrompt)と、隠しルール(hiddenRules)を合体！
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          // 合体したプロンプトを送る
          { role: "system", content: finalSystemPrompt },
          ...messages
        ],
        model: modelId || "llama-3.3-70b-versatile",
        stream: true,
        temperature: 0.6,
        max_tokens: parseInt(maxTokens) || 4096
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return new Response(JSON.stringify(errorData), { status: response.status });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = ""; 
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
              try {
                const json = JSON.parse(trimmed.substring(6));
                const content = json.choices[0]?.delta?.content || "";
                if (content) controller.enqueue(encoder.encode(content));
              } catch (e) { }
            }
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
