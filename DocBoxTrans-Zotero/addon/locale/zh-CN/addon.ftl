pref-title = DocBoxTrans

service-llm = 大模型
service-google = 谷歌
service-bing = 必应
service-tencent = 腾讯交互
service-youdao = 有道
service-cnki = 知网

popup-translate = 翻译
popup-context = 上下文
popup-context-title = 启用上下文增强翻译（参考本次会话中本文件、同引擎和目标语言的近期译文，不自动读取前后段落）
popup-empty = 请先在阅读器中选中要翻译的文本。

status-translating = 正在翻译…
status-cancelled = 已取消
status-empty-result = [请求错误] 翻译服务返回了空译文，请重试。
status-invalid-temperature = [配置错误] 采样温度必须是 0 到 2 之间的数字。
history-storageError = 翻译历史读取或保存失败，新记录暂存于内存。原有文件已保留。
history-storageRetry = 重试保存
status-empty-selection = [提示] 未选中任何文本。
status-unknown-service = [错误] 未知的翻译服务：
status-request-error = [请求错误]

test-running = 检测中…
test-ok = 连接正常：{ $detail }
test-fail = 检测失败：{ $detail }
test-need-config = 请先填写必需的密钥 / 接口配置

history-search = 搜索原文或译文
history-allTags = 全部标签
history-empty = 暂无翻译记录
history-emptyScope = 本篇暂无翻译记录
history-emptyFile = 本文件暂无翻译记录
history-copy = 复制
history-delete = 删除
history-previousVersion = 上一个译文
history-nextVersion = 下一个译文
history-resultCount = 共 { $count } 个翻译结果
history-deleteVersion = 删除当前显示的译文版本
history-tagPlaceholder = 标签
history-addTag = 加标签
history-removeTag = 移除标签
history-clear = 清空全部
history-clearScope = 清空本条目
history-clearFile = 清空本文件
history-clearConfirmTitle = 清空翻译历史
history-clearConfirmBody = 确定要清空全部翻译历史记录吗？此操作不可撤销。
history-clearScopeConfirmTitle = 清空本条目翻译历史
history-clearScopeConfirmBody = 确定要清空本条目的全部翻译历史记录吗？此操作不可撤销。
history-clearFileConfirmTitle = 清空本文件翻译历史
history-clearFileConfirmBody = 确定要清空本文件的全部翻译历史记录吗？此操作不可撤销。
history-jumpTitle = 点击跳转到原文位置
history-noPosition = 该记录未保存原文位置
history-currentEmpty = 暂无翻译结果
history-sortTitle = 排序方式
history-sortTime = 时间
history-sortSource = 原文顺序

popup-combine = 拼接
popup-combine-title = 开启后，新划选的片段会自动加入拼合区、暂停「选中文本后自动翻译」并清空上次译文；把多段拼接成一段后点「翻译」即可一并翻译。
combine-add = 追加
combine-addSelectionTitle = 请先在阅读器中选中要加入的文本
combine-translate = 翻译（{ $count }）
combine-translateTitle = 把拼合区的片段拼接成一段一并翻译
combine-clear = 清空
combine-removeTitle = 点击移除该片段

popup-cancel = 取消
popup-force = 强制重译
popup-force-title = 跳过历史译文复用，重新发送翻译请求
status-cancelled-partial = 已取消，部分译文已保留，尚未写入历史。
status-stream-incomplete = 译文流未完整结束，请重试。
status-stream-invalid = 翻译服务返回了无法解析的流式响应。
combine-moveUp = 上移片段
combine-moveDown = 下移片段
