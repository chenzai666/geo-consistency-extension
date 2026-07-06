# Geo-Locale Consistency

一个 Chrome MV3 扩展，让浏览器暴露给网页的地区信号——地理位置、时区、语言——与当前网络出口 IP 保持一致。解决了常见的"VPN 在东京，但 `Intl.DateTimeFormat().resolvedOptions().timeZone` 还显示 `America/New_York`"这类不一致问题，这类不一致本身就是指纹识别信号。

## 工作原理

1. **出口 IP 检测**（`lib/providers.js`、`background/service-worker.js`）：后台 Service Worker 依次请求 IP 地理位置 provider 链（`ipapi.co` → `ipwho.is` → `freeipapi.com` → `ipinfo.io`），取第一个成功返回的结果。保留国家码、城市/省份/国家、经纬度、ISP、IANA 时区。

2. **住宅坐标解析**（`lib/overpass.js`）：provider 返回的原始经纬度通常是数据中心或 ISP 机房，而非住宅地址。扩展会查询 OpenStreetMap Overpass API，在附近搜索 `highway=residential` 住宅道路并随机取其上一个点。若 Overpass 不可达或附近无数据，则回退到在配置精度半径内均匀分布的随机偏移（永远不会直接使用原始中心点）。

3. **语言环境推断**（`lib/locale.js`）：国家码 + IANA 时区（用于消歧加拿大、瑞士等多语言国家）通过静态离线表映射到 `navigator.language` / `navigator.languages` / `Accept-Language` 语言包。

4. **注入页面**（`content-scripts/`）：ISOLATED world 的"桥接"脚本读取 `chrome.storage.local` 中已计算好的配置（只有这个世界有权限访问），通过 DOM `CustomEvent` 转发给 MAIN world。MAIN world 的"注入"脚本在 `document_start` 执行——早于任何页面脚本——监听该事件并 patch 泄露位置/时区/语言的平台 API。

5. **`Accept-Language` 请求头**：通过 `declarativeNetRequest` 动态规则改写出站请求头，仅在语言开关开启时生效。

## 覆盖的 API

| API | 行为 |
|---|---|
| `navigator.geolocation.getCurrentPosition` / `watchPosition` / `clearWatch` | 返回解析后的住宅坐标而非真实 GPS/Wi-Fi 位置；位置开关关闭时透传原生实现 |
| `navigator.permissions.query({name:'geolocation'})` | 位置开关开启时返回 `granted`；否则委托原生检查 |
| `Date.prototype.getTimezoneOffset` | DST 感知：针对每个调用者 `Date` 实例，通过 `Intl.DateTimeFormat.formatToParts` 实时计算目标 IANA 时区偏移，而非缓存单一偏移值 |
| `Date.prototype.toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` | 调用者未传 `timeZone` 选项时默认使用伪装时区，保持内部一致性 |
| `Intl.DateTimeFormat`（构造函数默认值 + `resolvedOptions().timeZone`）| 调用者未指定时，`timeZone` 默认为伪装时区，`locales` 默认为伪装语言列表——通过向真实原生构造函数注入默认值实现，返回的是真正的 `Intl.DateTimeFormat` 实例而非假冒的 shim |
| `Intl.NumberFormat`、`Intl.Collator`（默认 locale）| 同上，仅注入 locale |
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

### 为什么 `content-scripts/main-injector.js` 不从 `lib/` import

通过 `manifest.json` `content_scripts` 数组注册的 content script 以经典（非模块）脚本运行，无法静态 import 其他文件，因此 DST 感知偏移公式直接内联在该文件中，而不通过打包工具共享。`tests/injector-tz-sync.test.js` 提取该内联副本（位于 `// TZ_FORMULA_START`/`END` 标记之间）并与 `lib/tz.js` 跑相同的测试矩阵，确保两者不会悄悄出现分歧。

## 加载扩展

1. 打开 `chrome://extensions` → 开启开发者模式
2. 点击"加载已解压的扩展程序" → 选择本目录
3. 打开弹窗配置各开关/精度/刷新间隔，点击刷新（或等待安装后的首次自动刷新）
