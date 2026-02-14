// api/chat.js
export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, modelId } = await req.json();
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません" }), { status: 500 });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        model: modelId || "llama-3.3-70b-versatile",
        stream: true,
        temperature: 0.7,
        max_tokens: 4096
      }),
    });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const json = JSON.parse(line.substring(6));
                const content = json.choices[0]?.delta?.content || "";
                if (content) {
                  controller.enqueue(encoder.encode(content));
                }
              } catch (e) { /* パースエラーは無視 */ }
            }
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
