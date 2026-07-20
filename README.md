# Geo-Locale Consistency

一个 Chrome MV3 扩展，让浏览器暴露给网页的地区信号——地理位置、时区、语言——与当前网络出口 IP 保持一致。解决了常见的"VPN 在东京，但 `Intl.DateTimeFormat().resolvedOptions().timeZone` 还显示 `America/New_York`"这类不一致问题，这类不一致本身就是指纹识别信号。

## 安装

### 方式一：从 Chrome 应用商店安装（推荐）

> 应用商店链接发布后更新此处。

### 方式二：本地加载（开发者模式）

1. 下载本仓库（`Code → Download ZIP` 或 `git clone`）
2. 打开 Chrome，地址栏输入 `chrome://extensions`
3. 右上角开启**开发者模式**
4. 点击**加载已解压的扩展程序**，选择本仓库根目录（含 `manifest.json` 的那一层）
5. 扩展图标出现在工具栏，安装完成

---

## 使用说明

### 快速上手

安装后扩展会**立即自动运行**——后台自动检测出口 IP、推算时区和语言、计算住宅坐标，无需任何手动操作。点击工具栏的扩展图标，弹窗中可看到当前生效的配置。

### 弹窗界面说明

```
┌─────────────────────────────────────────┐
│  Geo-Locale Consistency          [刷新]  │
├─────────────────────────────────────────┤
│  IP            203.0.113.42             │
│  位置          Tokyo, Tokyo, Japan      │
│  ISP           AS2527 NTT               │
│  时区          Asia/Tokyo               │
│  语言          ja-JP,ja;q=0.9,en;q=0.8  │
│  坐标来源      overpass (35.68, 139.69) │
│  Provider      ipapi.co                 │
│  更新时间      2026/7/6 15:30:00        │
├─────────────────────────────────────────┤
│  [✓] 伪装位置   [✓] 伪装时区  [✓] 伪装语言 │
├─────────────────────────────────────────┤
│  精度          均衡（~500m）  ▼          │
│  刷新间隔（分钟） 60                     │
│  ipinfo.io token  ············          │
├─────────────────────────────────────────┤
│              [保存设置]                  │
└─────────────────────────────────────────┘
```

| 控件 | 说明 |
|---|---|
| **刷新按钮**（右上角 ↻）| 立即重新检测出口 IP 并更新所有覆盖值 |
| **伪装位置** | 开关：控制 `navigator.geolocation` 是否返回伪装坐标 |
| **伪装时区** | 开关：控制 `Date`/`Intl` 时区相关 API 是否使用出口 IP 所在时区 |
| **伪装语言** | 开关：控制 `navigator.language(s)` 和出站 `Accept-Language` 请求头 |
| **精度** | 精确（~100m）/ 均衡（~500m）/ 城市级（~3000m），控制坐标偏移半径 |
| **刷新间隔** | 自动重新检测出口 IP 的周期，最小 5 分钟，默认 60 分钟 |
| **ipinfo.io token** | 可选，填写后提升 ipinfo.io 的请求配额（本地存储，不上传） |

### 典型使用场景

**场景 1：配合 VPN / 代理使用**

切换 VPN 节点后，点一下弹窗右上角的**刷新按钮**，扩展重新检测新的出口 IP，几秒内所有网页看到的位置、时区、语言都会更新为新节点所在地区的数据。

**场景 2：只伪装时区，不伪装位置**

在弹窗中关闭"伪装位置"，只保留"伪装时区"开关。此时 `navigator.geolocation` 正常工作（询问系统 GPS），但 `Date.getTimezoneOffset()`、`Intl.DateTimeFormat` 的默认时区都指向出口 IP 所在时区。

**场景 3：语言指纹消除**

开启"伪装语言"后，`navigator.language`/`languages` 和 HTTP `Accept-Language` 请求头都会切换为出口 IP 所在国家的主流语言（如出口在德国则为 `de-DE,de;q=0.9,en;q=0.8`），减少语言与地区不一致的指纹特征。

### 验证是否生效

打开任意网页的开发者工具（F12）→ Console，执行以下代码验证：

```js
// 验证时区
console.log(Intl.DateTimeFormat().resolvedOptions().timeZone);
// 预期：出口 IP 所在地的 IANA 时区，如 "Asia/Tokyo"

// 验证语言
console.log(navigator.language, navigator.languages);
// 预期：出口 IP 所在地的语言，如 "ja-JP" ["ja-JP","ja","en"]

// 验证时区偏移（东京 JST = UTC+9，返回 -540）
console.log(new Date().getTimezoneOffset());

// 验证地理位置
navigator.geolocation.getCurrentPosition(p =>
  console.log(p.coords.latitude, p.coords.longitude)
);
// 预期：出口 IP 附近的住宅坐标（非精确，有偏移）
```

### 注意事项

- **不要对银行、支付等敏感网站开启所有伪装**——位置/时区与账户注册地不一致可能触发风控。建议在 `chrome://extensions` → 扩展详情中将这类网站加入"不允许访问"列表。
- **坐标有随机偏移**，每次刷新结果不同，这是有意设计（防止固定坐标被识别）。
- 扩展更新出口 IP 信息需要访问几个公开的 IP 地理位置 API（见[隐私模型](#隐私模型)），请确保这些域名在代理规则中可正常访问：
  - `ipapi.co`
  - `ipwho.is`
  - `freeipapi.com`
  - `ipinfo.io`
  - `overpass-api.de`（OpenStreetMap Overpass）

---

## 工作原理

1. **出口 IP 检测**（`lib/providers.js`、`background/service-worker.js`）：后台 Service Worker 依次请求 IP 地理位置 provider 链（`ipapi.co` → `ipwho.is` → `freeipapi.com` → `ipinfo.io`），取第一个成功返回的结果。保留国家码、城市/省份/国家、经纬度、ISP、IANA 时区。

2. **住宅坐标解析**（`lib/overpass.js`）：provider 返回的原始经纬度通常是数据中心或 ISP 机房，而非住宅地址。扩展会查询 OpenStreetMap Overpass API，在附近搜索 `highway=residential` 住宅道路并随机取其上一个点。若 Overpass 不可达或附近无数据，则回退到在配置精度半径内均匀分布的随机偏移（永远不会直接使用原始中心点）。

3. **语言环境推断**（`lib/locale.js`）：国家码 + IANA 时区（用于消歧加拿大、瑞士等多语言国家）通过静态离线表映射到 `navigator.language` / `navigator.languages` / `Accept-Language` 语言包。

4. **注入页面**（`content-scripts/`）：ISOLATED world 的"桥接"脚本读取 `chrome.storage.local` 中已计算好的配置（只有这个世界有权限访问），通过 DOM `CustomEvent` 转发给 MAIN world。MAIN world 的"注入"脚本在 `document_start` 执行——早于任何页面脚本——监听该事件并 patch 泄露位置/时区/语言的平台 API。

5. **`Accept-Language` 请求头**：通过 `declarativeNetRequest` 动态规则改写出站请求头，仅在语言开关开启时生效。

## 覆盖的 API

| API | 行为 |
|---|---|
| `navigator.geolocation.getCurrentPosition` / `watchPosition` / `clearWatch` | 返回解析后的住宅坐标而非真实 GPS/Wi-Fi 位置；位置开关关闭时透传原生实现。`watchPosition` 以固定 10s 间隔轮询（不依赖调用方传入的 `maximumAge`），并在 payload 后续更新时（切换设置、刷新出口 IP、或首个 payload 姗姗来迟）自动在原生/伪装模式间切换，而不会卡在订阅时的初始状态 |
| `navigator.permissions.query({name:'geolocation'})` | 位置开关开启时返回 `granted`；否则委托原生检查 |
| `Date.prototype.getTimezoneOffset` | DST 感知：针对每个调用者 `Date` 实例，通过 `Intl.DateTimeFormat.formatToParts` 实时计算目标 IANA 时区偏移，而非缓存单一偏移值 |
| `Date.prototype.toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` | 调用者未传 `timeZone` 选项时默认使用伪装时区、未传 `locales` 参数时默认使用伪装语言列表，两者相互独立（分别只取决于时区伪装/语言伪装各自的开关），保持与 `Intl.DateTimeFormat` 一致的内部一致性。这几个方法绑定的是原始 `%DateTimeFormat%` intrinsic，patch 全局 `Intl.DateTimeFormat` 对它们不生效，因此单独 patch |
| `Intl.DateTimeFormat`（构造函数默认值 + `resolvedOptions().timeZone`）| 调用者未指定时，`timeZone` 默认为伪装时区，`locales` 默认为伪装语言列表——通过向真实原生构造函数注入默认值实现，返回的是真正的 `Intl.DateTimeFormat` 实例而非假冒的 shim |
| `Intl.NumberFormat`、`Intl.Collator`、`Intl.Segmenter`、`Intl.PluralRules`、`Intl.ListFormat`、`Intl.RelativeTimeFormat`（默认 locale）| 同上，仅注入 locale；运行时不存在的构造函数会被跳过 |
| `navigator.language` / `navigator.languages` | 在 `Navigator` 原型上覆盖 getter |

## 已知限制：同步 API 的竞态窗口

`chrome.storage.local` 是异步的，但部分被 patch 的 getter（`navigator.language`、`Date.prototype.getTimezoneOffset`、`Intl.DateTimeFormat` 默认值）是同步的。MAIN world 注入脚本在 `document_start` 立即 patch 这些函数，但它们应返回的*值*要等到 ISOLATED bridge 的 `chrome.storage` 读取完成并派发事件后才能到达——通常只需几毫秒，一般早于页面自身脚本执行，但对于在最初同步 tick 就读取这些值的脚本无法做出硬保证。在 payload 到达之前，这些 getter 会回退到真实的未伪装值。这是 MV3 异步存储 API 的结构性限制，不是 bug。

异步 API（`getCurrentPosition`、`watchPosition`、`permissions.query`）没有这个问题——它们直接等待 payload 到达后再返回，与正常的 GPS/网络延迟无法区分。

## 隐私模型

- **无 telemetry、无统计分析、无账号、无远程配置。** 扩展不会向任何服务器发送数据，开发者也没有运营任何服务器。
- **不读取页面内容。** MAIN world 注入脚本仅 patch 函数引用，从不检查 DOM、页面脚本或页面数据。ISOLATED world 桥接脚本只读取 `chrome.storage.local` 并派发一个 `CustomEvent`。
- **存储 100% 本地化。** 所有设置和计算结果（IP、位置、时区、语言、ISP）只存在 `chrome.storage.local` 中，不使用 `chrome.storage.sync`、cookie 或任何服务端存储。
- **唯一的出站网络请求**：
  - 请求上述 IP 地理位置 provider，获取当前出口 IP 的国家/城市/坐标/ISP/时区；
  - 请求 OpenStreetMap Overpass API，查找附近合理的住宅坐标。
  这两类请求都是计算覆盖值的必要手段，与真实网站仅凭 IP 地址已能推断的信息相同——扩展不会增加连接服务器所能获知的信息，只是让浏览器自身上报的信号与之保持一致。
- **可选的 `ipinfo.io` token** 由用户在 popup 中填写，仅存储在 `chrome.storage.local`，只在扩展向 `ipinfo.io` 发起的请求中以查询参数方式附带。

## 弹窗设置

- 独立开关：位置伪装 / 时区伪装 / 语言伪装
- 精度预设：精确（~100m）/ 均衡（~500m）/ 城市级（~3000m）——同时控制 Overpass 搜索半径和 jitter 回退半径
- 自动刷新间隔（分钟），通过 `chrome.alarms` 定时重新检测
- 可选 `ipinfo.io` token，提升 provider 请求配额
- 手动刷新按钮

## 开发

```sh
npm test
```

运行 Node 测试套件（`node --test`），覆盖：

- DST 感知时区偏移计算，含夏令时切换瞬间和南半球反向 DST（`tests/tz.test.js`），以及内联在 MAIN world content script 中的时区公式与 `lib/tz.js` 实现一致性的交叉验证（`tests/injector-tz-sync.test.js`）
- 语言环境推断，含多语言国家的时区消歧和 Accept-Language 头格式化（`tests/locale.test.js`）
- 四个 IP 地理位置 provider 的响应解析和 fallback 顺序（`tests/providers.test.js`）
- Overpass 查询构造、响应解析和 jitter 回退几何（`tests/overpass.test.js`）
- manifest content script 注入顺序——MAIN world 注入脚本必须先于 ISOLATED world 桥接脚本声明，保证事件监听器在桥接派发前已就绪（`tests/manifest.test.js`）
- 设置规范化和 declarativeNetRequest 规则构造（`tests/storage-and-dnr.test.js`）
- `content-scripts/isolated-bridge.js` 硬编码的 storage key 字符串与 `lib/storage-schema.js` 中 `STORAGE_KEYS` 的一致性校验（`tests/isolated-bridge-keys-sync.test.js`）
- `Date.prototype.toLocaleString` 系列方法的伪装 locale/timeZone 相互独立生效，在隔离的 `node:vm` 沙箱里实际执行 `main-injector.js` 验证（`tests/injector-locale-timezone-independence.test.js`）

### 为什么 `content-scripts/main-injector.js` 不从 `lib/` import

通过 `manifest.json` `content_scripts` 数组注册的 content script 以经典（非模块）脚本运行，无法静态 import 其他文件，因此 DST 感知偏移公式直接内联在该文件中，而不通过打包工具共享。`tests/injector-tz-sync.test.js` 提取该内联副本（位于 `// TZ_FORMULA_START`/`END` 标记之间）并与 `lib/tz.js` 跑相同的测试矩阵，确保两者不会悄悄出现分歧。

同样的约束也适用于 `content-scripts/isolated-bridge.js`：它硬编码了 `SETTINGS_KEY`/`PROFILE_KEY` 字符串常量，而不是从 `lib/storage-schema.js` import `STORAGE_KEYS`。`tests/isolated-bridge-keys-sync.test.js` 用同样的思路——提取源码里的字面量，与 `STORAGE_KEYS` 交叉校验——防止未来重命名 key 时悄悄失效。

## 加载扩展

1. 打开 `chrome://extensions` → 开启开发者模式
2. 点击"加载已解压的扩展程序" → 选择本目录
3. 打开弹窗配置各开关/精度/刷新间隔，点击刷新（或等待安装后的首次自动刷新）
