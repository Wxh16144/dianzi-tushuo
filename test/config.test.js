import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_PRESETS,
  displayHost,
  isLoopbackHost,
  isWildcardHost,
  lanAddresses,
  resolveHost,
  resolveLlmConfig,
} from '../server/config.js';

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

describe('监听地址解析', () => {
  test('--host 不带值时监听所有网卡（同 Vite）', () => {
    assert.equal(resolveHost({ cliHost: true, envHost: '127.0.0.1' }), '0.0.0.0');
  });

  test('--host 带值优先于环境变量', () => {
    assert.equal(resolveHost({ cliHost: '192.168.1.9', envHost: '127.0.0.1' }), '192.168.1.9');
  });

  test('没有 --host 时回落到 HOST 环境变量', () => {
    assert.equal(resolveHost({ envHost: '0.0.0.0' }), '0.0.0.0');
  });

  test('都没有时默认只听本机', () => {
    assert.equal(resolveHost({}), '127.0.0.1');
    assert.equal(resolveHost({ envHost: '  ' }), '127.0.0.1');
  });

  test('all / lan / true / * 视为通配', () => {
    for (const value of ['all', 'lan', 'true', '*', '0.0.0.0', '::']) {
      assert.equal(resolveHost({envHost: value}), '0.0.0.0', value);
    }
  });

  test('判断通配与回环', () => {
    assert.equal(isWildcardHost('0.0.0.0'), true);
    assert.equal(isWildcardHost('192.168.1.9'), false);
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
  });

  test('展示地址：通配时显示 localhost', () => {
    assert.equal(displayHost('0.0.0.0'), 'localhost');
    assert.equal(displayHost('192.168.1.9'), '192.168.1.9');
  });
});

describe('局域网地址枚举', () => {
  test('只保留非内部 IPv4，排除虚拟网卡与链路本地地址', () => {
    const fake = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.31.197', family: 'IPv4', internal: false },
      ],
      utun3: [{ address: '198.18.0.1', family: 'IPv4', internal: false }],
      en5: [{ address: '169.254.10.20', family: 'IPv4', internal: false }],
    };
    assert.deepEqual(lanAddresses(fake), ['192.168.31.197']);
  });

  test('私网地址排在公网前面', () => {
    const fake = {
      en0: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
      en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    };
    assert.deepEqual(lanAddresses(fake), ['10.0.0.5', '8.8.4.4']);
  });

  test('没有可用地址时返回空数组', () => {
    assert.deepEqual(lanAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), []);
  });
});
