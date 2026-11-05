# Third-party notices

This project is an independent implementation. No source code from DeepSeek Harness internal packages, DS-bot, or another plugin is copied into this repository.

The design was informed by the public Host APIs of DeepSeek Harness 0.2.1-rc.5 and by the Apache-2.0-licensed DS-bot project's documented delivery sequence (resolveAgent + custom-source createUserMessage + followup + flush). DS-bot's HTTP `sessionController.prompt` path and its queue/memory/room modules are not used.

The Web chat presentation also follows [DS-Bot](https://github.com/Fei2411/DS-Bot)'s stable author/bubble layout and its documented long-message folding interaction (Apache-2.0). The skin is implemented for this plugin against public Host Slots, Markdown and image factories; DS-Bot's runtime, Bot roster, server logic, avatars and artwork are not bundled.

Runtime peer dependencies (`@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, and optional React/Schemastery peers declared in `package.json`) remain the property of their respective authors and are not vendored here.
