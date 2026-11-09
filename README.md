[README.md](https://github.com/user-attachments/files/34563537/README.md)
# Power BI 多车辆轨迹视觉对象（阶段五）

基于 Power BI Custom Visual SDK 7.2.1 / API 5.11.1 与高德地图 JS API 2.0 的内部验证工程。前四阶段包括地图接入、多 VIN 轨迹、异常标记、配色和 Power BI 交互；阶段五加入起终点和坐标系转换。

## 本地构建和验证

```powershell
npm install
npm run test:processor
npm run lint
npm run package
```

打包结果位于 `dist/`。导入 Power BI Desktop 后，点击视觉对象顶部的“地图凭据”按钮输入 Web Key 和 `securityJsCode`；输入框使用圆点遮挡，已保存的凭据不会回填显示，留空保存可保留已有值。发布前请在 `pbiviz.json` 中将示例维护者邮箱和 support URL 换成项目实际信息。

## Power BI 字段映射与地图功能

必填：Longitude、Latitude、VIN、Timestamp。`AbnormalTag` 可选；不绑定时所有点按普通点绘制。源坐标系可选 GCJ-02、WGS-84 或 BD-09；数据处理模块统一转换为 GCJ-02 后再连线和绘制。点位详情保留来源坐标，并在需要时同时显示转换后的 GCJ-02 坐标。

按 VIN 分组后，各组按时间戳升序排列；同一时间戳保留原始行顺序和重复点。无效坐标、空 VIN 和无效时间会跳过并计数。VIN 会被稳定映射到自动色卡，颜色不会因行顺序或切片器筛选而变化。格式窗格可分别为轨迹线和普通点选择鲜明、柔和或色盲友好色卡，不需要逐个 VIN 配置。

地图左侧车辆列表显示 VIN、点数和异常数，可单独显示/隐藏轨迹；点击 VIN 定位到该车。顶部提供全部显示、全部隐藏、FitView 和清除选择。点击 GPS 点会打开详情并通过 SelectionManager 选择对应原始数据行；按住 Ctrl 点击可累加选择。Power BI 会据此筛选或交叉高亮其他视觉对象。若当前 Power BI 场景禁止交互，点位详情仍可打开，但不会发出选择。

异常标签规则：true / 1 / “异常”标为异常；false / 0 / “正常”标为正常。空值计数并按正常点处理。无法识别的值会单独计数和提示，并用琥珀色标记；异常点始终红色，带白色描边并置于普通点上层。每车最早时间点标记为绿色起点，最晚时间点标记为深蓝终点；单点车辆只显示一个“起终”标记。点位详情包含 VIN、坐标、时间、组内顺序和异常状态。

格式窗格可选择圆点或定位图钉，并分别为轨迹线和普通点选择色卡。鲜明/柔和色卡按 VIN 稳定生成扩展色域；色盲友好方案是 8 色循环。数据量上限为 1,000 行。

可用 `sample-data.csv` 检查标签映射；用 `sample-data-no-abnormal.csv` 验证未绑定异常字段时仍能绘图。示例坐标假定为 GCJ-02。

## 高德配置与安全

1. 在高德开放平台创建 Web 端 JS API Key，限制来源并设置配额。
2. 按高德 JS API 2.0 安全文档配置 `securityJsCode`。视觉对象内的密码框只遮挡输入显示；凭据仍会随报表保存，并可能被有权限的报表使用者或浏览器运行环境读取，不应将其视为加密或密钥保管库。
3. `capabilities.json` 声明对 `*.amap.com` 与 `*.autonavi.com` 的 `WebAccess` 权限。管理员策略、容器网络/CSP、企业代理和高德来源校验均可能阻止加载。
4. 源坐标系默认 GCJ-02；选择 WGS-84 或 BD-09 时，视觉对象在统一数据处理模块内转换为 GCJ-02。WGS-84 中国范围外坐标保留原值。

## 阶段验证状态与边界

- 已完成 TypeScript 编译、10 项数据处理单元测试、ESLint 与 `.pbiviz` 打包。
- 点选 SelectionId 由该 DataView 行的类别身份构建；`supportsMultiVisualSelection` 已启用。
- 起终点按排序后的第一/最后记录确定；坐标转换支持北京等国内坐标及中国范围外 WGS-84 原值保留。
- 新增起终点和坐标系设置仍需在目标 Power BI Desktop 报表中进行地图实测。
- 高德依赖外部脚本和地图资源，因此本工程面向内部使用，不满足 Power BI AppSource 认证对外部资源的限制。

## 目录结构

```text
vehicleTrackVisual/
├── capabilities.json       # 数据角色、多视觉对象选择和 WebAccess
├── src/
│   ├── dataProcessor.ts    # 校验、标签归一化、VIN 分组和稳定排序
│   ├── coordinateTransform.ts # WGS-84 / BD-09 转 GCJ-02
│   ├── settings.ts         # Key、坐标系、点形态和配色方案
│   └── visual.ts           # VIN 控制、地图绘制和 SelectionManager
├── tests/processor.test.cjs
├── style/visual.less
├── sample-data.csv
├── sample-data-no-abnormal.csv
├── pbiviz.json
└── package.json
```
