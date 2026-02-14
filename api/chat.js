// api/chat.js
import Groq from "groq-sdk";

export const config = {
  runtime: "edge", // 10秒の壁を突破するためにエッジ環境を使うみつ！
};

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, modelId } = await req.json();

    const stream = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      model: modelId || "llama-3.3-70b-versatile",
      stream: true, // ストリーミングを有効化だみつ！
    });

    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            controller.enqueue(encoder.encode(content));
          }
        }
        controller.close();
      },
    });

    return new Response(readableStream, {
      headers: { "Content-Type": "text/event-stream" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
