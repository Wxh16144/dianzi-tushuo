import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_PRESETS, resolveLlmConfig } from '../server/config.js';

describe('LLM 预设解析', () => {
  test('默认 ollama：本地地址 + qwen3 + 关闭思考', () => {
    const llm = resolveLlmConfig({ provider: 'ollama' });
    assert.equal(llm.provider, 'ollama');
    assert.equal(llm.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(llm.model, 'qwen3:4b');
    assert.equal(llm.reasoningEffort, 'none');
    assert.equal(llm.configured, true);
  });

  test('deepseek：用官方地址，密钥有效', () => {
    const llm = resolveLlmConfig({ provider: 'deepseek', apiKey: 'sk-test' });
    assert.equal(llm.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(llm.model, 'deepseek-chat');
    assert.equal(llm.apiKey, 'sk-test');
    assert.equal(llm.reasoningEffort, '');
  });

  test('openai 预设', () => {
    const llm = resolveLlmConfig({ provider: 'openai', apiKey: 'sk-oai' });
    assert.equal(llm.baseUrl, 'https://api.openai.com/v1');
    assert.equal(llm.model, 'gpt-4o-mini');
  });

  test('显式 baseUrl / model 覆盖预设', () => {
    const llm = resolveLlmConfig({
      provider: 'deepseek',
      baseUrl: 'https://proxy.example.com/v1///',
      model: 'my-model',
    });
    assert.equal(llm.baseUrl, 'https://proxy.example.com/v1', '末尾斜杠应被去掉');
    assert.equal(llm.model, 'my-model');
  });

  test('兼容旧变量名 OLLAMA_BASE_URL / OLLAMA_MODEL', () => {
    const llm = resolveLlmConfig({
      provider: 'ollama',
      legacyBaseUrl: 'http://192.168.1.9:11434/v1',
      legacyModel: 'qwen2:7b',
    });
    assert.equal(llm.baseUrl, 'http://192.168.1.9:11434/v1');
    assert.equal(llm.model, 'qwen2:7b');
  });

  test('custom 无地址时视为未配置', () => {
    const llm = resolveLlmConfig({ provider: 'custom' });
    assert.equal(llm.configured, false);
    assert.equal(llm.baseUrl, '');
    assert.equal(llm.model, '');
  });

  test('未知 provider 回退到 custom', () => {
    const llm = resolveLlmConfig({ provider: 'nope', baseUrl: 'https://x/v1', model: 'm' });
    assert.equal(llm.provider, 'custom');
    assert.equal(llm.configured, true);
  });

  test('每个预设都有 label 与 baseUrl 字段', () => {
    for (const [name, preset] of Object.entries(LLM_PRESETS)) {
      assert.ok(preset.label, `${name} 缺 label`);
      assert.ok('baseUrl' in preset, `${name} 缺 baseUrl`);
      assert.ok('model' in preset, `${name} 缺 model`);
    }
  });
});

describe('LLM.publicInfo 不泄露密钥', () => {
  test('只暴露 hasApiKey', async () => {
    const { LLM } = await import('../server/config.js');
    const info = LLM.publicInfo;
    assert.equal(Object.hasOwn(info, 'apiKey'), false);
    assert.equal(typeof info.hasApiKey, 'boolean');
    assert.deepEqual(Object.keys(info).sort(), ['baseUrl', 'hasApiKey', 'label', 'model', 'provider']);
  });
});
