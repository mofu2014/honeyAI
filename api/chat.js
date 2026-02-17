// api/chat.js
export const config = { runtime: "edge" };

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { messages, systemPrompt, maxTokens, selectedMode } = await req.json();

    // 1. 全キーを収集
    let allKeys = [
      { key: process.env.GEMINI_API_KEY, type: 'gemini', name: 'Gemini Main' },
      { key: process.env.SAMBANOVA_API_KEY, type: 'sambanova', name: 'SambaNova 1' },
      { key: process.env.SAMBANOVA_API_KEY_2, type: 'sambanova', name: 'SambaNova 2' },
      { key: process.env.GROQ_API_KEY, type: 'groq', name: 'Groq Llama' }
    ].filter(item => item.key);

    for (let i = 1; i <= 50; i++) {
        const k = process.env[`GEMINI_KEY_${i}`];
        if (k) allKeys.push({ key: k, type: 'gemini', name: `Gemini ${i}` });
    }

    // --- 2. モードによるフィルタリング ---
    let providersToTry = [];
    if (selectedMode === 'gemini') {
      providersToTry = allKeys.filter(k => k.type === 'gemini');
    } else if (selectedMode === 'llama') {
      providersToTry = allKeys.filter(k => k.type === 'sambanova' || k.type === 'groq');
    } else {
      providersToTry = allKeys; // 自動（シャッフル）
    }

    // シャッフルして特定のキーへの集中を防ぐ
    providersToTry = providersToTry.sort(() => Math.random() - 0.5);

    const hiddenRules = ` 一人称「私」。名乗るの禁止。メタ発言禁止。装飾：重要は**太字**、強調は<span style="color:red">赤色</span>。語尾「〜だみつ」。`;
    const finalSystemPrompt = (systemPrompt || "") + "\n\n" + hiddenRules;

    let lastError = null;

    // --- 3. プロバイダーを渡り歩くループ ---
    for (const provider of providersToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒待機

      try {
        let apiUrl, body, headers = { "Content-Type": "application/json", "X-Forwarded-For": getRandomIP() };

        if (provider.type === 'gemini') {
          // Gemini 404対策：モデル名を「gemini-1.5-flash」に固定し、URLを最新版に修正
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${provider.key}`;
          body = {
            contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
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
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();

          return new Response(new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(`[:model:${provider.name}:]`));
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (provider.type === 'gemini') {
                  const matches = buffer.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
                  if (matches) {
                    matches.forEach(m => { try { const t = JSON.parse(`{${m}}`).text; controller.enqueue(encoder.encode(t)); } catch(e){} });
                    buffer = "";
                  }
                } else {
                  const lines = buffer.split("\n");
                  buffer = lines.pop();
                  for (const line of lines) {
                    const l = line.trim();
                    if (l.startsWith("data: ") && l !== "data: [DONE]") {
                      try { const content = JSON.parse(l.substring(6)).choices[0]?.delta?.content || ""; if (content) controller.enqueue(encoder.encode(content)); } catch (e) {}
                    }
                  }
                }
              }
              controller.close();
            }
          }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        } else {
          // 404や429が出た場合、このキーは飛ばして即座に次へ行く
          const errText = await response.text();
          lastError = `${provider.type} (${response.status}): ${errText.substring(0, 50)}`;
          console.warn(`Retry Triggered: ${lastError}`);
          continue; 
        }
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }
    // 全キー失敗時
    return new Response(JSON.stringify({ error: `全AIが多忙、または設定ミスです。(${lastError})` }), { status: 429 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
