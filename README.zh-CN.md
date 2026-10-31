<div align="center">

<img src=".github/assets/kiori-icon.webp" width="148" alt="Kiori">

# Kiori

**让每个角色都拥有自己的心智。**

他们记得什么、从未见过什么、爱着谁、藏着什么。<br>
聊天、模型和大脑都留在你的应用里。Kiori 不存储任何大脑，也不存储任何聊天记录。

[![Tests](https://github.com/kiori-ai/kiori/actions/workflows/test.yml/badge.svg)](https://github.com/kiori-ai/kiori/actions/workflows/test.yml)
[![Stars](https://img.shields.io/github/stars/kiori-ai/kiori?style=flat&color=2b4acb)](https://github.com/kiori-ai/kiori/stargazers)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-2b4acb?style=flat)](#-许可证)
[![Last commit](https://img.shields.io/github/last-commit/kiori-ai/kiori?style=flat&color=2b4acb)](https://github.com/kiori-ai/kiori/commits)
[![Website](https://img.shields.io/badge/website-kiori.io-2b4acb?style=flat)](https://kiori.io)
[![Docs](https://img.shields.io/badge/docs-kiori.io%2Fdocs-2b4acb?style=flat)](https://kiori.io/docs)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-2b4acb?style=flat)](docs/self-hosting.md)
[![Dependencies](https://img.shields.io/badge/dependencies-0-2b4acb?style=flat)](package.json)

[English](README.md) | **简体中文**

</div>

---

## ⚡ Kiori 是什么

它不是聊天机器人，而是你的聊天机器人背后的心智。对话由你的应用负责，每一句台词由你的模型来写；Kiori 负责"记住"。它为每个角色构建大脑，随着故事推进不断更新，并在角色开口之前，把这个角色此刻真正知道的东西交给你的模型。

> **你交给 Kiori：** 一张角色卡（或者一个名字加一段描述），以及正在发生的聊天。
>
> **Kiori 交还给你：** 一个由你保管的大脑；这个角色此刻知道的一切（可以直接放进你的提示词）；他们刚刚学到了什么；以及（如果你需要）一份草稿回复是否泄露了他们从未听说过的事情。

适用于任何模型、任何语言。你使用自己的模型密钥（OpenRouter、OpenAI 或 Gemini），直接向你的模型服务商付费。

## 🌸 为什么叫 "Kiori"

> **記 (ki)**：记录、记忆。**織 (ori)**：编织。<br>
> Kiori 就是*编织记忆的人*：她把发生过的事、在场的人、低声说出的秘密，编织成只属于这个角色的心智。她也是我们的吉祥物：短发波波头、歪斜的光环，替你守住秘密。

<p align="center"><img src=".github/assets/mascot-shh.webp" width="200" alt="Kiori 守着一个秘密"></p>

## 📸 看看它

**走进一个心智。**记忆、人物、情感、地点和秘密，各在各的分支上。用户一开口，相关的部分在一瞬间亮起，你的模型就带着这些写出回复。

<p align="center"><img src=".github/assets/brain.webp" alt="被问到她信任谁时，她想起四件事：哥哥、你、脆弱的信任和一个被打破的承诺"></p>

**一个故事，三个心智。**Rosa 出去接电话时，Mei 把一个秘密告诉了 Kai。之后分别问他们：只有在场的人才知道。

<p align="center"><img src=".github/assets/three-minds.webp" alt="一个晚上的四张拍立得；之后 Mei 说出了巴黎，Kai 说这不该由他来说，Rosa 什么都不知道"></p>

在 **[kiori.io](https://kiori.io)** 上在线体验。

## 🧠 心智里有什么

| | |
|---|---|
| **会淡去的记忆** | 他们记得自己经历过的事。小事渐渐模糊，大事一直留着；一夜的睡眠会把几天的经历整理成故事。 |
| **守得住的秘密** | 每个心智只知道自己看到、听到或被告知的事。一句悄悄话只留在当时在场的人那里。 |
| **他们在乎的人** | 信任、人情、心动与怨恨，一个人一个人地记着，随着故事推进而变化。 |
| **内心世界** | 会延续的情绪、习惯、恐惧和信念：建立在人人共有的 99% 之上，再加上只属于他们的那 1%。 |

被编辑、重新生成或删除的消息会被察觉，并撤回从中学到的东西。群聊也是一样：每个角色只学习自己在场的场景。

## 🔄 工作原理

三个调用，这就是全部的集成工作。

1. **描述他们**（`create`）：发送一张角色卡，或一个名字加一段描述。大约一分钟，Kiori 就会构建出一个完整的大脑：一段过去、其中的人物、一个内心世界。赶时间？轻量大脑即时生成，而且免费。
2. **告诉它发生了什么**（`organize`）：发送大脑和最近的聊天，大脑会变得更"懂事"地回来。每个人只学到自己亲眼见到的事。
3. **在他们开口之前询问**（`recall`）：一瞬间拿到你的模型需要的一切。这是检索，不是生成，所以几乎不花钱。还可以选择在显示之前用 `check` 检查草稿有没有泄密。

```js
let brain = await kiori.create({ character_card: card });                     // 每个角色一次：由你保管
const { text } = await kiori.recall({ brain, messages: chat.slice(-60) });     // 每次回复之前：放进你的提示词
({ brain } = await kiori.organize({ brain, messages: chat.slice(-60) }));      // 回复之后：它会学习
```

## 🧭 选哪种方式？

| | **Kiori API** | **SillyTavern 扩展** | **即插即用（drop-in）** | **自己部署** |
|---|---|---|---|---|
| **最适合** | 应用、游戏和平台 | 玩家 | 已经在用 OpenAI 风格 API 的应用 | 想掌控一切的人 |
| **接入方式** | 在控制台拿一个密钥，3 个调用 | 粘贴一个网址，再粘贴密钥 | 换一个 base URL | 一个 Node 进程，一个 SQLite 文件 |
| **大脑由谁保管** | 你（Kiori 不存储任何大脑） | 你的聊天文件和角色卡 | 你 | 你 |
| **你的模型** | 任意，用你自己的密钥 | SillyTavern 支持的任意模型 | 任意 OpenAI 兼容模型 | 任意 |

## 🚀 快速开始

SDK 没有任何依赖：`npm install kiori`（JavaScript，Node 18+ 和浏览器）和 `pip install kiori-ai`（Python 3.8+）。每个 SDK 也是一个可以直接复制的单个文件：[`sdk/kiori.mjs`](sdk/kiori.mjs) 和 [`sdk/kiori.py`](sdk/kiori.py)。

<details open>
<summary><b>JavaScript</b></summary>

```js
import { Kiori } from 'kiori';
const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY });

let brain = await kiori.create({ character_card: card });
const { text } = await kiori.recall({ brain, messages: chat.slice(-60) });
const reply = await yourModel({ system: `${yourCharacterPrompt}\n\n${text}`, messages: chat });
chat.push({ role: 'assistant', content: reply });
({ brain } = await kiori.organize({ brain, messages: chat.slice(-60) }));
```
</details>

<details>
<summary><b>Python</b></summary>

```python
import os
from kiori import Kiori

kiori = Kiori(os.environ["KIORI_API_KEY"])
brain = kiori.create(character_card=card)
context = kiori.recall(brain=brain, messages=chat[-60:])
reply = your_model(system=your_character_prompt + "\n\n" + context["text"], messages=chat)
chat.append({"role": "assistant", "content": reply})
brain = kiori.organize(brain=brain, messages=chat[-60:])["brain"]
```
</details>

<details>
<summary><b>即插即用（任何 OpenAI 客户端）</b></summary>

```js
const ai = new OpenAI({ baseURL: 'https://api.kiori.io/v1', apiKey: process.env.KIORI_API_KEY });
const reply = await ai.chat.completions.create({ model: 'your/chat-model', messages, stream: true, kiori: { brain } });
```

每个角色的心智会被加进你的系统提示词，请求再转发给你的模型。支持流式输出；不保存任何东西。
</details>

<details>
<summary><b>SillyTavern</b></summary>

在 SillyTavern 里打开 **Extensions → Install extension**，粘贴 `https://github.com/kiori-ai/SillyTavern-Kiori`（也可以从控制台下载扩展，解压到 `data/default-user/extensions`）。然后在 **Extensions → Kiori** 里粘贴你的 Kiori 密钥。每个角色在你们第一次对话时得到一个大脑；它保存在你电脑上的聊天文件里。
</details>

<details>
<summary><b>部署你自己的 Kiori</b></summary>

只需要 Node.js 22.13 或更新版本，不用安装别的东西：

```bash
git clone https://github.com/kiori-ai/kiori && cd kiori
echo "KIORI_LLM_KEY=sk-or-..." > .env          # 你的模型密钥（默认 OpenRouter）
node bin/kiori.mjs project create "My app"     # 打印这个项目的 Kiori 密钥（只显示一次）和控制台登录链接
node bin/kiori.mjs serve                       # API、控制台和文档：http://127.0.0.1:7700
```

设置、命令行和部署到服务器：见 [docs/self-hosting.md](docs/self-hosting.md) 和 [deploy/](deploy/)。自己部署对个人和非商业用途免费；用于商业产品或服务，请看[许可证](#-许可证)。
</details>

## 🔒 从设计上保护隐私

- **没有可以泄露的东西。** Kiori 不存储任何大脑和聊天记录。大脑是一个 JSON 对象，随每次调用往返，保存在你想保存的地方。
- **你的模型密钥始终是密封的。** 静态加密（AES-256-GCM），只会发送给保存时对应的服务商，也永远不会完整地显示出来。
- **调用只去该去的地方。** 模型调用只通过 https 发往公网地址；私有网络和云元数据地址在建立连接时就会被拒绝。
- **每一行都可以读。** 一个进程，零依赖，服务端代码大约 3,600 行。详见 [docs/security.md](docs/security.md)。

## 📚 文档

| | |
|---|---|
| [概念](docs/concepts.md) | 大脑文件、在场、整理者（organizer）、审核者（auditor）、睡眠 |
| [集成](docs/integration.md) | 各个调用、保管大脑、群聊、即插即用、SillyTavern、错误处理 |
| [API 参考](docs/api.md) | 每个接口、字段和错误码（也有 [`/openapi.json`](https://kiori.io/openapi.json)） |
| [安全](docs/security.md) | 存了什么、没存什么，以及密钥如何保管 |
| [自己部署](docs/self-hosting.md) | 设置、命令、服务器工具包 |

文档目前只有英文版。

## 🗺️ 路线图

- [x] 从角色卡构建大脑、从聊天中学习、检索、泄密检查
- [x] JavaScript 和 Python SDK、OpenAI 兼容的即插即用接口、SillyTavern 扩展
- [x] npm 和 PyPI 包
- [ ] 一个公开的基准测试：群聊中"谁知道什么"，有 Kiori 和没有 Kiori 的对比
- [ ] Kiori 自己的小型大脑模型，让学习的成本只有现在的一小部分

## 🤝 社区

Kiori 目前处于免费公测阶段，公测期间免费，适用[测试版条款](https://kiori.io/terms)和[隐私政策](https://kiori.io/privacy)（英文）。[立即使用](https://kiori.io/#access)，提一个 [issue](https://github.com/kiori-ai/kiori/issues)，或者写信到 **help@kiori.io**。你告诉我们的，会决定我们接下来做什么。

## 📄 许可证

个人和非商业用途免费；商业用途需要授权。

- **Kiori 本体**（除 `sdk/` 和 `sillytavern/` 以外的全部内容）以 [PolyForm Noncommercial License 1.0.0](LICENSE) 公开源代码。只要是非商业用途，都可以阅读、运行、修改和分享：个人项目、学习、研究、业余爱好，或者慈善机构、学校和公共机构。
- **在商业产品或服务中运行它**需要商业授权，请写信到 **help@kiori.io**。
- **SDK 和 SillyTavern 扩展**采用 [MIT](sdk/LICENSE) 许可：可以用在任何地方，包括商业产品。
- **从你的应用调用托管版 Kiori**（`api.kiori.io`），无论是否商用，都属于使用我们的服务，不适用这个许可证。

Kiori 这个名字、标志和吉祥物插画不在这些许可证的范围内。

## 📈 Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=kiori-ai/kiori&type=Date)](https://star-history.com/#kiori-ai/kiori&Date)

<div align="center"><sub>如果你的角色会说话，他们就值得被记住 ✦</sub></div>
