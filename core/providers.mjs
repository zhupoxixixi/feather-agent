/** Dependency-free model adapters. No credential or response body enters errors. */
export class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', status = null) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value);
const validName = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const tokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const invalidInput = () => { throw new ProviderError('Invalid model request.', 'INVALID_REQUEST'); };
const invalidResponse = () => { throw new ProviderError('The model returned an invalid or unsupported response.', 'INVALID_RESPONSE'); };

function integer(value, fallback, maximum) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new ProviderError('Invalid model configuration.', 'INVALID_CONFIG');
  return number;
}

function endpointFor(baseUrl, type) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new ProviderError('Invalid API base URL.', 'INVALID_CONFIG'); }
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !local) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('Use an HTTPS API URL, or loopback HTTP, without URL credentials, query or fragment.', 'INVALID_CONFIG');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (type === 'openai') {
    if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  } else if (!url.pathname.endsWith('/messages')) {
    url.pathname += url.pathname.endsWith('/v1') ? '/messages' : '/v1/messages';
  }
  return url;
}

function argumentsObject(value, invalid) {
  if (typeof value !== 'string' || value.length > 262144) return invalid();
  let result;
  try { result = JSON.parse(value); } catch { return invalid(); }
  if (!isObject(result)) return invalid();
  return result;
}

function validateCalls(calls, invalid) {
  if (!Array.isArray(calls) || calls.length > 32) return invalid();
  const ids = new Set();
  for (const call of calls) {
    if (!isObject(call) || !validId(call.id) || ids.has(call.id) || call.type !== 'function' || !isObject(call.function) || !validName(call.function.name)) return invalid();
    argumentsObject(call.function.arguments, invalid);
    ids.add(call.id);
  }
}

function validateRequest(messages, tools) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 10000 || !Array.isArray(tools) || tools.length > 64) invalidInput();
  for (const message of messages) {
    if (!isObject(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) invalidInput();
    if (message.role === 'assistant') {
      if (message.content !== null && typeof message.content !== 'string') invalidInput();
      if (message.tool_calls !== undefined) validateCalls(message.tool_calls, invalidInput);
    } else if (typeof message.content !== 'string') invalidInput();
    if (message.role === 'tool' && !validId(message.tool_call_id)) invalidInput();
  }
  const names = new Set();
  for (const tool of tools) {
    if (!isObject(tool) || !validName(tool.name) || names.has(tool.name) || typeof tool.description !== 'string' || !isObject(tool.parameters)) invalidInput();
    names.add(tool.name);
  }
}

function openAIMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.role === 'assistant' && message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    ...(message.role === 'tool' ? { tool_call_id: message.tool_call_id } : {}),
  }));
}

function anthropicMessages(messages) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const result = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = [];
    if (message.role === 'tool') {
      let failed = false;
      try { failed = JSON.parse(message.content)?.ok === false; } catch {}
      content.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content, ...(failed ? { is_error: true } : {}) });
    } else {
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: argumentsObject(call.function.arguments, invalidInput) });
      }
      if (!content.length) content.push({ type: 'text', text: '(empty message)' });
    }
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  if (!result.length || result[0].role !== 'user') invalidInput();
  return { system, messages: result };
}

function normalizeOpenAI(data) {
  const choice = data?.choices?.[0];
  const raw = choice?.message;
  if (!isObject(raw) || raw.role !== 'assistant') invalidResponse();
  const content = raw.content === null && typeof raw.refusal === 'string' ? raw.refusal : raw.content;
  if (content !== null && typeof content !== 'string') invalidResponse();
  const calls = raw.tool_calls ?? [];
  validateCalls(calls, invalidResponse);
  if ((!content || !content.trim()) && !calls.length) invalidResponse();
  if (choice.finish_reason != null && typeof choice.finish_reason !== 'string') invalidResponse();
  return {
    message: {
      role: 'assistant', content,
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) } : {}),
    },
    usage: { inputTokens: tokens(data.usage?.prompt_tokens), outputTokens: tokens(data.usage?.completion_tokens) },
    finishReason: choice.finish_reason ?? null,
  };
}

function normalizeAnthropic(data) {
  if (data?.role !== 'assistant' || !Array.isArray(data.content) || data.content.length > 128) invalidResponse();
  const texts = [];
  const calls = [];
  for (const block of data.content) {
    if (!isObject(block)) invalidResponse();
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use' && isObject(block.input)) {
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    } else invalidResponse();
  }
  validateCalls(calls, invalidResponse);
  const content = texts.length ? texts.join('\n') : null;
  if ((!content || !content.trim()) && !calls.length) invalidResponse();
  if (data.stop_reason != null && typeof data.stop_reason !== 'string') invalidResponse();
  return {
    message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) },
    usage: { inputTokens: tokens(data.usage?.input_tokens), outputTokens: tokens(data.usage?.output_tokens) },
    finishReason: data.stop_reason ?? null,
  };
}

async function limitedJSON(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError('The model response exceeded its byte limit.', 'RESPONSE_TOO_LARGE');
  }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        throw new ProviderError('The model response exceeded its byte limit.', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalidResponse(); }
}

function retryDelay(header, attempt) {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(5000, Math.max(0, date - Date.now()));
  }
  return Math.min(2000, 250 * 2 ** attempt);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ProviderError('Model request cancelled.', 'ABORTED')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new ProviderError('Model request cancelled.', 'ABORTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createProvider(options = {}) {
  const type = options.type ?? 'openai';
  if (!['openai', 'anthropic'].includes(type) || typeof options.model !== 'string' || !options.model.trim() || options.model.length > 256 || /[\r\n]/.test(options.model)) {
    throw new ProviderError('A supported provider and model name are required.', 'INVALID_CONFIG');
  }
  const apiKey = options.apiKey ?? '';
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new ProviderError('Invalid API credential configuration.', 'INVALID_CONFIG');
  const endpoint = endpointFor(options.baseUrl || (type === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'), type);
  const timeoutMs = integer(options.timeoutMs, 60000, 600000);
  const maxOutputTokens = integer(options.maxOutputTokens, 2048, 131072);
  const maxResponseBytes = integer(options.maxResponseBytes, 2097152, 2097152);
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new ProviderError('Invalid retry budget.', 'INVALID_CONFIG');

  return {
    async complete({ messages, tools = [], signal } = {}) {
      validateRequest(messages, tools);
      const request = type === 'openai'
        ? { model: options.model, messages: openAIMessages(messages),
            [endpoint.hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
            ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}) }
        : { model: options.model, ...anthropicMessages(messages), max_tokens: maxOutputTokens,
            ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}) };
      let body;
      try { body = JSON.stringify(request); } catch { invalidInput(); }
      if (Buffer.byteLength(body) > 8388608) throw new ProviderError('Model request exceeds its byte budget.', 'REQUEST_TOO_LARGE');
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (type === 'openai' && apiKey) headers.authorization = 'Bearer ' + apiKey;
      if (type === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (apiKey) headers['x-api-key'] = apiKey;
      }
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      if (signal?.aborted) throw new ProviderError('Model request cancelled.', 'ABORTED');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        for (let attempt = 0; ; attempt++) {
          let response;
          try { response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' }); }
          catch {
            if (controller.signal.aborted) throw new ProviderError(timedOut ? 'Model request timed out.' : 'Model request cancelled.', timedOut ? 'TIMEOUT' : 'ABORTED');
            if (attempt < maxRetries) { await wait(retryDelay(null, attempt), controller.signal); continue; }
            throw new ProviderError('Could not reach the model API.', 'NETWORK_ERROR');
          }
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const delay = retryDelay(response.headers.get('retry-after'), attempt);
            await response.body?.cancel().catch(() => {});
            if (retryable && attempt < maxRetries) { await wait(delay, controller.signal); continue; }
            throw new ProviderError('Model API request failed (HTTP ' + response.status + ').', 'HTTP_ERROR', response.status);
          }
          const data = await limitedJSON(response, maxResponseBytes);
          return type === 'openai' ? normalizeOpenAI(data) : normalizeAnthropic(data);
        }
      } catch (error) {
        if (controller.signal.aborted) throw new ProviderError(timedOut ? 'Model request timed out.' : 'Model request cancelled.', timedOut ? 'TIMEOUT' : 'ABORTED');
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('Could not read the model API response.', 'NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
