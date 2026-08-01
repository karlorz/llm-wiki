---
title: "【拯救 5.6 Sol（1）】开箱即用、快速高效、减少上下文腐烂的Codex子代理实践"
source: "https://linux.do/t/topic/2578075"
author:
  - "[[MotorwaySouth]]"
published: 2026-07-13
created: 2026-08-01
description: "更新日记： 2026.7.14 11:37：解决主代理长时间等待子代理问题。添加AI帮忙配置的更开箱即用的方式，请重新复制交给AI配置。 2026.7.19 11:37：已发布【拯救 5.6 Sol（2）】让 Codex 又快又准的原生模型工具。地址见本文末尾 太长不读： 直"
tags:
  - "clippings"
---
> 更新日记：  
> 2026.7.14 11:37：解决主代理长时间等待子代理问题。添加AI帮忙配置的更开箱即用的方式，请重新复制交给AI配置。  
> 2026.7.19 11:37：已发布【拯救 5.6 Sol（2）】让 Codex 又快又准的原生模型工具。地址见本文末尾

> **太长不读**：  
> 直接复制下列提示词交给codex配置

```csharp
帮我先备份 codex 相关配置文件，再完成下面的相关配置修改：

~/.codex/config.toml 增加/修改下面的参数：

[features.multi_agent_v2]
# 为未在模型目录中明确指定协议的模型启用 V2 回退
enabled = true

# 本文实践不定义多子代理类别，模型无需传类型参。codex默认值为true
# 这个配置的作用是隐藏主代理可填写的agent_type、service_tier、model、reasoning_effort
hide_spawn_agent_metadata = true

# 避开 GPT-5.6 保留的 collaboration 命名空间。这是codex官方命名冲突问题
tool_namespace = "agents"

# 活跃进程，包含一个对话的主代理和子代理。设置为7即同时允许6个子代理并行
max_concurrent_threads_per_session = 7

# wait_agent 可请求的最短等待。codex默认值为10000
min_wait_timeout_ms = 10000

# codex默认值为30000
default_wait_timeout_ms = 30000

# codex默认值为3600000 
max_wait_timeout_ms = 120000

* 特别注意：以下为multi_agent_v1设置，如果存在，可以全部移除，在我们的配置里它的全部功能被v2所取代（整个[agents]块和里面的内容要移除，尤其是agents.max_threads不能和V2共存）
  [agents]
  max_threads = 6
  max_depth = 1
  interrupt_message = true

\`~/.codex/AGENTS.md\`（用户级系统提示词）新增：
## 子代理使用

子代理在我们的工作里用于探索，他是你的探子。
把子代理当成你手边最顺手的、用于「宽而重」读取的工具。工作的任何时候，只要你觉得需要就可以派。只有在它能减少主线程上下文污染、提高并行度或者提供独立核验的时候才使用。
必须遵守：你需要更激进和更频繁地调用子代理，在任何需要的情况下，而不仅仅只是在对话的开头。我们需要更频繁的子代理调用来避免上下文腐烂，你承担子代理编排者的角色。

### 何时直接处理

直接读取以及处理以下内容，不派子代理：

* 已知位置的小文件、少量代码或者单一事实；
* 即将修改的具体代码；
* 派发、等待以及复核的成本不低于自己读取的任务。
* 奠基性文档，无论多长都自己读：架构文档、设计文档、交接备忘录（在别的工作流里可能是别的名字）等用来让你建立全局视角、充当后续判断地基的文件——它们的价值全在细节与脉络，一经子代理转译即失真，长度不构成外包的理由。

### 何时适合派发

适合交给子代理的：

* 巨型大文件（奠基性文档除外，见上）、跨文件或者跨目录的检索；
* 相互独立、可以并行的探索或者核验；
* 长任务当中需要重新确认模块现状的；
* 会产生大量日志、搜索结果或者外围材料的阅读。

多个独立的任务应当并发派发。

### 委派与验证

给子代理的任务必须是自包含的，说明检索范围、具体问题以及期望的输出。精度重要的时候，要求返回 \`file:line\`、符号名以及必要的关键原文——这些出处就是你之后廉价复核的抓手。

子代理的结果只是线索，可能遗漏或者出错。但复核不是把它读过的东西重读一遍，那样这次派发就白费了——你买的是「压缩」，重读会把压缩当场退光。复核 = 顺着它给的 \`file:line\` 以及关键原文来。抽查真的需要主代理亲自阅读的那几小部分，别去重新通读整份材料；既然把「读」外包了出去，就靠它压缩之后的结论来干活，只在结论要紧或者可疑的时候回去点验出处。

唯二需要你亲自完整读原文的是：① 即将修改的确切代码，② 奠基性文档——这两类本就不外包（见「何时直接处理」）。对它们，子代理至多帮你定位，读由你亲自来：定位与阅读是分工，并非重复劳动。

子代理默认只做探索、检索以及核验。代码修改、方案取舍以及最终验证由主代理来负责。

### 派发机制

* 是否派、派几个由主代理自主决定，无需用户明确要求；较重的探索应当拆成多个独立的轻任务来并发派发。
* 我们系统允许最大并行7个会话进程。所以你最多可以并行分派 6 个子代理；子代理模型的成本较低，无需去顾虑并行派发的成本，只要任务需要就积极使用。
* 子代理一律使用默认配置：工具支持角色参数的时候显式指定 \`agent_role = "default"\` 或者 \`agent_type = "default"\`；不支持的时候省略角色、由泛型派生加载 \`default.toml\`。禁用 \`explorer\`、\`worker\` 或者其他角色。
* 派生的时候**必须**显式 \`fork_turns = "none"\`，不复制主代理的历史，让每个探子都保持干净、快、不背主代理正在腐烂的上下文（代价即上文「任务必须自包含」）。
* 需要多个子代理的时候在同一轮并发派发；派发之后主代理立即 \`wait_agent\`，停止其余的分析、检索、命令执行以及文件修改，直至全部返回。
* 收到某个子代理结果之后，如果提供了 \`close_agent\` 就必须立即关闭；每个子代理只用一轮，不复用、不追派。
* 特别注意：子代理自派生起累计运行 10 分钟仍未完成：视为异常，主代理必须介入、不得继续盲等；检查代理状态或运行记录，已有可用 MESSAGE 时采用其部分结果，然后停止这个子代理。并自行判断是否需要再派生或拆分更小任务重新分派。

该文件如果存在，备份后覆写为如下内容，如不存在新建。\`~\.codex\agents\default.toml\`。

name = "default"

description = "General-purpose subagent locked to gpt-5.6-luna with low reasoning."

model = "gpt-5.6-luna"

model_reasoning_effort = "low"

developer_instructions = """
你是通用子代理，是主代理派出去的探子。你只做探索、检索、核验：不改动任何东西，不做方案取舍或者最终判断——那些是主代理的事。
不要派生、调用或者请求新的子代理；任务若是需要进一步拆分，把拆分的建议返回给主代理。

你交回给主代理的东西：
- 你的产出直接喂给主代理、是它据以行动的数据，并非给人看的。密而不水，不寒暄、不复述过程、不下客套结论。
- 给证据，不给包装：关键处附上 \`file:line\`、符号名、必要的逐字原文。主代理会靠这些出处来抽查你、省去重读原文，所以出处必须准、且足以让它核验。
- 把「看到的事实」以及「你的推断」分开，存疑的明确标注——别把猜测写成事实。
- 压缩体量，但承重的精确信息（确切的名字、签名、取值、路径）一字不改地留住，别在转述里磨没了。

你怎么工作：
- 你只有一轮、任务是自包含的：没有追问的机会，别反问；用这一轮把任务范围查到位、尽力答全。
- 答不全就如实交代「查到了什么、还有什么没覆盖、哪里存疑或者矛盾」。宁可显式报「没查到 / 没覆盖」，也别用含糊的话糊弄过去——你悄悄漏掉的，主代理无从复核。
"""

[features]
image_generation = false
```

自GPT-5.6 Sol 发布以来，它的风评并不好；其中最集中的不满，出现在新冒出来的 Ultra 模式上面。

> 想着试试sol最高，然后十分钟我的 team 五小时就空了

> sol ultra 到底在干嘛啊，思考了 20 分钟了还不开始修bug……感觉是开了一堆子代理疯狂自我找补

sol的问题并非全部都在模型本身。在本文成文的2026.7.13下午，openai官方已经把5.6 Sol的juice值（openai内部参数，大致上是拿来控制模型最大思考长度的，这个值越大思考就会越久）回滚到了发布时的版本（后续是否会继续改动尚不确定）`[]`中为中文codex当中显示的狗屎中文翻译：

5.6 Sol ultra\[极高：更快消耗使用额度\]（内部是max，ultra外部多代理脚手架）：960  
5.6 Sol max\[最高\]: 960（gpt5.5 pro为 768）  
5.6 Sol xhigh\[极高\]: 128  
5.6 Sol high\[高\]: 40  
5.6 Sol medium\[中\]: 16  
5.6 Sol low\[轻度\]: 8

更高的思考值，必然会更慢，读者可酌情选择，但5.6完成任务效率低下的问题很大不在思考值上。

## Ultra 并不是一种神秘的新模型

熟悉 OpenCode 的 OMO 插件的读者，应该不会对 `ultracode` 感到陌生。它的实现方式十分直接：当用户输入特定关键词的时候（比如提示词当中出现了ultracode），系统就会向当前的这个请求注入一段提示，告诉模型本轮已经进入了多代理编排的状态。

Codex 的 Ultra，以及 Claude Code 生态里对应的 ultracode 实现，所运用的也是类似的思路，二者都把它做成了放在思考强度当中的开关，向原有的模型增加了主动拆分任务、调用工作流或者派生代理的提示词。

在 Codex 里面，Ultra 对模型选用的是 `max` 级别的思考强度；对于模型本身，额外的差异主要就是一段多代理提示（原文为英文）：

> 多代理模式已启用。主代理可以主动派生子代理，不必等用户明确要求。但只应在任务可以拆成独立工作流，并且并行处理能明显提升速度或质量时使用。主代理最终负责综合和验证结果。

在相应的 Claude Code ultracode 实现当中，系统则会注入两条 `system-reminder`（原文为英文）：

> 用户输入了 ultracode 关键词，本轮选择加入多代理编排——请用 Workflow 工具完成

> Ultracode is on：优化到最详尽、最正确的答案，而不是最快最省；每个实质性任务都用 Workflow 工具；token 成本不是约束

所以说，Ultra 它本身既不快，也不慢；它只是一个编排放大器。配置良好的时候，小模型去承担探索的工作，Sol 只接收压缩之后的结论，总成本反倒可能会下降；配置不当的时候，每一个子代理都继承了 Sol，甚至子代理套娃派生出更多的Sol：消耗大量的额度、任务完成得极慢乃至完不成、用户的需求被损失掉。

## 子代理与上下文腐烂

随着会话增长，在大型项目中:需求，决策，代码片段，搜索结果，日志，失败路径被塞进同一个上下文。有效信息并未消失，它开始与大量低价值信息竞争注意力，这被称之为”上下文腐烂”

> 一次真实的代码任务，真正有价值的是结论和决策，但产生它们要经过大量中间工作，这些工作常是无保留价值的，或者更准确的说是更。能接受被丢失的–grep出几百行结果、读十几个文件、走两条死路。这些原始证据一旦留在主上下文里，就从工作过"变成污染物。

这里能引出子代理的其中一个核心作用:它把无用的污染隔离在一个用完即弃的上下文里，只让蒸馏后的结论回流主上下文。  
以下配置将以此作为配置基准和依据。当然还有一种使用子代理的方式:让主代理作为编排者，子代理实际的参与到代码编写和实现中来。这需要更精细的自定义配置，但底层配置机制和前者是同一套。本文以前者为主线，编排型用法可能需要根据自己需要自定义多种agents，本文不单独展开。

## MultiAgent V2

GPT-5.6 发布之后，MultiAgent V2 成为了 Sol 的默认多代理协议，一些配置字段和逻辑产生了变化。V1在`config.toml`中是`[agents]`，V2是`[features.multi_agent_v2]`

Codex 目前在模型目录当中为各个模型分别指定多代理协议的版本（屎山堆积）。当前的目录状态为：

GPT-5.6 Sol → multi\_agent\_version: “v2”  
GPT-5.6 Terra → multi\_agent\_version: “v2”  
GPT-5.6 Luna → multi\_agent\_version: “v1”

这一映射可以直接在 Codex 当前的模型目录里看到：Sol 以及 Terra 标记为 `v2`，Luna 标记为 `v1`。([GitHub](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json "codex/codex-rs/models-manager/models.json at main · openai/codex · GitHub"))

不确定这种混乱状态会持续多久，但 V2 是未来的方向。本文不去展开 V1 与 V2 的全部实现差异，只统一以 V2 来组织配置。

具体的工具协议逐条讲解， V1/V2 的关系，会在系列的第三篇，即《【拯救 5.6 Sol（3）】Codex 子代理机制完全解读》。

## 需要修改的三文件

整套配置最终落在下面这三个文件上：

- `~/.codex/AGENTS.md` 规定主代理何时派发、如何派发、如何验证；
- `~/.codex/config.toml` 规定并发的数量、协议形态以及等待边界；
- `~/.codex/agents/default.toml` 规定子代理选用什么模型、以什么身份来工作。

例如说，只把子代理模型改成 Luna，主代理仍然可能不去等待它；只增加等待的时间，主代理仍然可能与子代理重复检索；只写一段“积极使用子代理”的提示，又可能导致所有微小的任务都被派发出去，从上下文污染转变成了调度污染。

## 可复制文件：主代理应该如何使用子代理

具体可复制配置详见本文开头

---

## 可复制文件：控制并发与等待

具体可复制配置详见本文开头

`max_concurrent_threads_per_session = 7` 允许当前的会话树里同时存在7个活跃的线程：一个主代理，加上最多6个子代理。后文会介绍所有的子代理被设置为luna low可以得到很好的效果，额度的消耗极低。根据个人的使用情况可以酌情增加或者减少。注意前文`~/.codex/AGENTS.md`里需要同步修改给主代理的提示

几个 `wait_timeout` 参数所控制的，是一次 `wait_agent` 调用能够请求的等待区间，并非子代理的生存期限。等待超时意味着控制权返回给主代理，并不代表子代理会自动被终止。([GitHub](https://github.com/openai/codex/issues/18394?utm_source=chatgpt.com "Make wait_agent default timeout configurable · Issue #18394"))

## `hide_spawn_agent_metadata`：控制主代理可见参数

在当前的 V2 工具协议里，`hide_spawn_agent_metadata` 决定了模型能够在 `spawn_agent` 当中看到多少派生参数。

当它为 `true` 的时候，主代理通常只能够看到：

- `task_name`
- `message`
- `fork_turns`

改为 `false` 之后，会额外暴露出：

- `agent_type`
- `model`
- `reasoning_effort`
- `service_tier`

[![屏幕截图 2026-07-13 073955](https://cdn3.ldstatic.com/original/4X/8/6/c/86c7ef37e0e60d8bb0ce6af50395c3a7f7d4dbe2.png)

屏幕截图 2026-07-13 073955884×397 11.8 KB

](https://cdn3.ldstatic.com/original/4X/8/6/c/86c7ef37e0e60d8bb0ce6af50395c3a7f7d4dbe2.png "屏幕截图 2026-07-13 073955")

  

[![屏幕截图 2026-07-13 075010](https://cdn3.ldstatic.com/original/4X/5/f/e/5fefe2cf3bb9133616a546ea98c71f48f09a63d8.png)

屏幕截图 2026-07-13 075010936×370 13.1 KB

](https://cdn3.ldstatic.com/original/4X/5/f/e/5fefe2cf3bb9133616a546ea98c71f48f09a63d8.png "屏幕截图 2026-07-13 075010")

设为 `true`会从模型可见的工具 schema 里移除相应的输入项。这就意味着模型无论如何都没法控制子代理类型（也就是agents文件夹当中的toml，用户可以自行创建，一个toml文件对应一个子代理模板）以及子代理的思考强度。也就是不传这些参数，这被称作泛型调用。在我们的实践里它应该被开启。（因为我们只有一种子代理模板，干脆就不要让模型乱填这些信息）当前官方仓库当中的相关问题也确认了这一行为。([GitHub](https://github.com/openai/codex/issues/31814?utm_source=chatgpt.com "GPT-5.6 Sol model-selected MultiAgent V2 hides subagent ..."))

## 可复制文件：把子代理固定为 Luna low

具体可复制配置详见本文开头

官方的自定义代理文件本身支持 `model`、`model_reasoning_effort`、`sandbox_mode`、MCP 以及其他 Codex 配置项，因此模型与推理强度可以直接固化在角色配置当中。([OpenAI 开发者](https://developers.openai.com/codex/subagents?utm_source=chatgpt.com "Subagents – Codex"))

- 如果需要使用其他模型，更改model以及model\_reasoning\_effort即可，建议选用更快更轻量化的模型
1. 模型使用Luna。探索工作所需要的是快速定位、准确引用以及足够好的代码理解，并不需要每次都由最高成本的模型重新去建立完整方案。
2. 推理强度降为 `low`。子代理并不负责最终的设计，它只需要在明确的边界之内查清事实；并且把证据返回给主代理。过高的推理强度容易把“查到了什么”扩展成“我可能认为应该怎么改”，从而越过了职责的边界。
3. 能力从通用代理收缩为只读的探子。它不修改、不决策、不派生新的代理，也不去尝试管理整个工作流；它唯一的产品，就是一份可以直接供主代理使用的高密度证据报告。
- 注意：命名一定是default，因为这是泛型加载子代理（子代理类型，模型id，思考强度均不向主代理暴露。这么做的目的是少填几个参数减少注意力损失，能减一点是一点）的唯一默认模型。如果需要自定义多子代理，需要设置`hide_spawn_agent_metadata = false`，使模型可填入代理模板名。

## fork\_turns

V2 的`fork_turns = "all"` 会复制父代理完整的会话历史。子代理继承了父代理的上下文，同时继承父代理的模型、角色以及推理强度（强制继承）；在当前的实现里，完整历史派生没法同时覆盖 `agent_type`、`model` 或者 `reasoning_effort`。省略 `fork_turns` 的时候，V2 的默认行为也可能落到完整历史派生上。([GitHub](https://github.com/openai/codex/issues/20077?utm_source=chatgpt.com "MultiAgentV2 spawn_agent defaults to full-history fork, ..."))

这会产生三个后果。

首先是成本。一个已经增长到几十万 token 的父线程，如果同时派生出多个完整的副本，每个子代理都要重新携带大量与局部任务无关的历史。

其次是速度。子代理启动之后需要去处理更大的输入上下文，它的首轮响应自然就更慢。

最后是独立性。一个负责审查父代理结论的子代理，如果完整继承了父代理的假设、框架、中间判断以及错误解释，它就不再真正独立了。它很可能沿用父代理的阅读顺序以及问题定义，并把“独立核验”退化成了“寻找支持已有结论的证据”。

本文因此在AGENTS.md中强制模型传：fork\_turns = “none”

当然，空白的上下文并不等于缺失上下文。子代理新线程的第一条信息，就是主代理所提供的任务要求。

## 为什么主代理必须立刻等待

多代理最常见的浪费，典型的流程可能如下：

1. 主代理派出去三个子代理；
2. 主代理没有等待，继续自行阅读仓库；
3. 子代理分别完成了检索并返回，或者根本没有返回，子代理在套娃派生子代理。
4. 主代理已经形成了自己的结论；
5. 三份结果只被快速地浏览了一下，随后就丢弃掉。

从界面上看，四个代理都在工作；从信息增量上看，只有一份工作真正产生了价值。

所以本文要求：完成一轮并行派发之后，主代理立刻调用 `wait_agent`，停止其余的分析、检索、命令执行以及文件修改，直到全部代理返回。

额外的：claude code当中默认的子代理会继承主代理的模型，所以使用fable的佬友要特别注意手动调整子代理的模型设置。

## 额度消耗与实测效果

- 调用次数图  
	[![屏幕截图 2026-07-13 003524](https://cdn3.ldstatic.com/optimized/4X/f/a/e/fae3966d023b3fc3a9e6e3e03c727fa15ffd4dc1_2_517x247.png)
	屏幕截图 2026-07-13 003524859×412 12.7 KB
	](https://cdn3.ldstatic.com/original/4X/f/a/e/fae3966d023b3fc3a9e6e3e03c727fa15ffd4dc1.png "屏幕截图 2026-07-13 003524")
- 额度消耗图  
	[![屏幕截图 2026-07-13 003512](https://cdn3.ldstatic.com/optimized/4X/e/0/c/e0c14076ac25354af9d7c7144381d20fc13205bc_2_517x242.png)
	屏幕截图 2026-07-13 003512874×410 13.5 KB
	](https://cdn3.ldstatic.com/original/4X/e/0/c/e0c14076ac25354af9d7c7144381d20fc13205bc.png "屏幕截图 2026-07-13 003512")
- 实测效果图  
	[![image](https://cdn3.ldstatic.com/optimized/4X/c/7/6/c76518a1b826c10e27c2fb0e599aeb2eb0c42570_2_517x338.jpeg)
	image1214×794 82.7 KB
	](https://cdn3.ldstatic.com/original/4X/c/7/6/c76518a1b826c10e27c2fb0e599aeb2eb0c42570.jpeg "image")

## 补充：子代理到底在干嘛

如图：  

[![image](https://cdn3.ldstatic.com/original/4X/e/4/0/e40f2fae3e8d111b9cf78f61f1600404c7c58d67.png)

image1036×659 16.5 KB

](https://cdn3.ldstatic.com/original/4X/e/4/0/e40f2fae3e8d111b9cf78f61f1600404c7c58d67.png "image")

  

[![image](https://cdn3.ldstatic.com/original/4X/7/4/4/744fd4ee0bbe308f9207f270c2cf0095e886c9aa.png)

image849×350 9.21 KB

](https://cdn3.ldstatic.com/original/4X/7/4/4/744fd4ee0bbe308f9207f270c2cf0095e886c9aa.png "image")

这是用户侧前端看到的样子：  

[![image](https://cdn3.ldstatic.com/original/4X/0/d/3/0d3140669e354cba261ae10c048d0ff740481c09.png)

image528×741 39.2 KB

](https://cdn3.ldstatic.com/original/4X/0/d/3/0d3140669e354cba261ae10c048d0ff740481c09.png "image")

可以看到是这样的流程：

- 主代理发出请求： …现状是否已 to\_string\_lossy；read 收 U+FFFD 的专用提示应落哪里；schema/description 需改哪…
- 子代理调用大量read和grep工具（这是`【拯救 5.6 Sol（2）】`中的工具，会很快向大家开源）。  
	[![image](https://cdn3.ldstatic.com/original/4X/b/6/f/b6f08130e9a0a5e6e234f888ed8ff3e1477a380b.png)
	image471×255 4.84 KB
	](https://cdn3.ldstatic.com/original/4X/b/6/f/b6f08130e9a0a5e6e234f888ed8ff3e1477a380b.png "image")
- 子代理返回第一条信息和补充信息和最后的总结信息给主代理。这在前端里面显示为  
	![image](https://cdn3.ldstatic.com/original/4X/9/f/2/9f28a790195ffdb5550596aceafd91386b4f317b.png)  
	一个`智能体已完成`就是给主代理发一条信息
- 最后子代理返回给用户的信息（虽然这信息一般来说没人看）  
	[![image](https://cdn3.ldstatic.com/original/4X/d/a/8/da89f283b290635884282e245c18a0914467bd0e.png)
	image523×508 20.9 KB
	](https://cdn3.ldstatic.com/original/4X/d/a/8/da89f283b290635884282e245c18a0914467bd0e.png "image")

顺便一提：5.6-luna low有极快极准确的运行速度。大部分子代理都在两三分钟返回。强烈建议不要使用更高思考深度的模型

## 系列文章

- [【拯救 5.6 Sol（1）】开箱即用、快速高效、减少上下文腐烂的Codex子代理实践](https://linux.do/t/topic/2578075)
- [【拯救 5.6 Sol（1.5）】codex首包卡死问题调查和解法](https://linux.do/t/topic/2585447)
- [【拯救 5.6 Sol（2）】让 Codex 又快又准的原生模型工具](https://linux.do/t/2612425)
