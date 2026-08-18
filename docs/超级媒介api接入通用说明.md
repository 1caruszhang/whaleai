## 超级媒介api接入通用说明

### 请求地址

https://vip.chaojimeijie.com/api

### 公共请求参数

用于标识代理商和鉴权接口请求，在后面的单独接口文档中不再对这些参数进行说明，每次请求接口请务必带上这些参数。

| 名称      | 类型   | 必填 | 默认   | 说明                                                         |
| :-------- | :----- | :--- | :----- | :----------------------------------------------------------- |
| appid     | string | Yes  | -      | 用于标识代理商                                               |
| timestamp | int    | Yes  | -      | 当前时间戳（10位），验证请求的时效性，5分钟内有效。          |
| algorithm | string | No   | sha256 | 用于签名的散列算法名称，如：sha1，sha256等。参见[hash_hmac_algos(): array](https://www.php.net/manual/zh/function.hash-hmac-algos.php) |
| signature | string | Yes  | -      | 使用密钥对请求数据的签名                                     |

### 公共响应数据

所有接口均以json格式返回，以下为公共的响应字段。

| 名称    | 类型   | 说明                                 |
| :------ | :----- | :----------------------------------- |
| code    | int    | 200 表示请求成功，其他表示请求失败   |
| message | string | 响应结果描述信息                     |
| data    | mixed  | 业务数据，具体说明参见对应的接口文档 |

### 签名算法

计算签名按照下面的步骤进行

1. 将所有请求参数（signature除外）按参数名升序排列；
   如果参数值为**列表**，按列表**元素**升序排列；
   如果参数值为**字典**，按字典**键名**升序排列；
   然后将数组展平并拼接为一个字符串。

   ```php
       function flatten(array $data, string $separator = ''): string
       {
           $segments = [];
           if (array_is_list($data)) {
               sort($data); // 如果是列表，按照值升序排序    
               foreach ($data as $item) {
                   $segments[] = is_array($item) ? flatten($item, $separator) : $item;
               }
           } else {
               ksort($data); // 如果是字典，按照键名升序排序       
               foreach ($data as $key => $item) {
                   if ($key === 'signature') continue;
                   $value = is_array($item) ? flatten($item, $separator) : $item;
                   $segments[] = sprintf('%s=%s', $key, $value);
               }
           }    
           return implode($separator, $segments);
       }
       
                       
   ```

2. 使用 HMAC 方法生成带有密钥的散列值

   ```php
       $secret = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
       $data = [
           'appid' => 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
           'timestamp' => time(),
           'algorithm' => 'sha256',
           'other' => '其他请求参数',
       ];
       $data['signature'] = hash_hmac($data['algorithm'], flatten($data), $secret);
       
                       
   ```

### 验证签名

```php
    $secret = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    $data = [
        'appid' => 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'timestamp' => time(),
        'algorithm' => 'sha256',
        'signature' => 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'other' => '其他请求参数',
    ];
    $signature = hash_hmac($data['algorithm'], flatten($data), $secret);
    hash_equals($signature, $data['signature']); // 验证结果
    
            
```



## 个人资料

请求路径：/profile

请求方式：GET

| 名称    | 类型   | 说明       |
| :------ | :----- | :--------- |
| name    | string | 用户名     |
| mobile  | string | 手机号码   |
| balance | float  | 余额（元） |



## 获取新闻媒体资源

请求路径：/media/resource

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                    |
| :--- | :--- | :--- | :--- | :---------------------- |
| page | int  | No   | 1    | 页码                    |
| size | int  | No   | 20   | 每页个数，最大限制为200 |

| 名称  | 类型 | 说明     |
| :---- | :--- | :------- |
| total | int  | 资源总数 |
| items | list | 资源列表 |

| 名称                     | 类型          | 说明                                                         |
| :----------------------- | :------------ | :----------------------------------------------------------- |
| id                       | int           | 资源标识                                                     |
| name                     | string        | 资源名称                                                     |
| entrance_link            | string\|null  | 入口链接                                                     |
| case_link                | string        | 案例链接                                                     |
| homepage_focus_image_url | string\|null  | 首页焦点图片地址                                             |
| homepage_recommend_time  | string\|null  | 首页推荐时间，如：3小时/天                                   |
| remark                   | string\|null  | 备注说明                                                     |
| price                    | decimal(10,2) | 成本价格，单位：元                                           |
| published_avg            | int           | 平均发稿时间，单位：分钟                                     |
| published_rate           | int           | 发稿率，0 ~ 100                                              |
| area                     | int           | 所属地区，参见[附录：所属地区](https://vip.chaojimeijie.com/agent/document#appendix:area) |
| link_type                | int           | 链接类型， 1: 不带联系方式 3: 网址                           |
| news_source              | int           | 新闻源， 1: 非新闻源 2: 百度新闻源                           |
| channel_type             | int           | 频道类型，参见[附录：频道类型](https://vip.chaojimeijie.com/agent/document#appendix:channel_type) |
| publish_speed            | int           | 发稿速度， 1: 一小时内 2: 二小时内 12: 半天 24: 当天 48: 隔天 49: 2天以上 |
| entrance_level           | int           | 入口级别， 1: 没有入口 2: 首页入口 3: 频道入口 4: 上级入口   |
| special_industry         | int           | 特殊行业， 1: 金融区块链 3: 党政加分 4: 健康 6: 白名单来源 7: 移动端媒体 8: 需要来源媒体 9: 首页焦点图/首页文字链 |
| record_situation         | int           | 收录情况， 1: 不包收录 2: 百度包收录                         |
| comprehensive_portal     | int\|null     | 综合门户，参见[附录：综合门户](https://vip.chaojimeijie.com/agent/document#appendix:comprehensive_portal) |
| pc_weight                | int\|null     | 电脑端百度权重，0~9                                          |
| mobile_weight            | int\|null     | 手机端百度权重，0~9                                          |
| can_weekend              | boolean       | 周末是否可以发稿                                             |
| status                   | int           | 状态，参见[附录：资源状态](https://vip.chaojimeijie.com/agent/document#appendix:resource:status) |



## 查询新闻媒体资源

请求路径：/media/resource/query

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                          |
| :--- | :--- | :--- | :--- | :---------------------------- |
| id   | list | Yes  | -    | 资源id列表，最大长度限制为200 |

响应数据data为有效资源列表，详情数据字段说明与[**获取新闻媒体资源**](https://vip.chaojimeijie.com/agent/document#/media/resource)接口返回的data['items']列表一致。



## 创建新闻媒体订单

请求路径：/media/order

请求方式：POST

| 名称            | 类型   | 必填 | 默认 | 说明                                                         |
| :-------------- | :----- | :--- | :--- | :----------------------------------------------------------- |
| sn              | string | Yes  | -    | 代理商订单号，必须唯一且最大长度限制为64                     |
| resource_id     | int    | Yes  | -    | 资源id                                                       |
| title           | string | Yes  | -    | 稿件标题，最大长度限制为200，**需要urlencode处理。**         |
| content         | string | Yes  | -    | 稿件内容预览地址，必须为正确的URL格式，**需要urlencode处理。** |
| publish_limited | date   | No   | null | 限时发布时间，必须为正确的时间格式，推荐格式：**"Y-m-d\TH:i:sP"**；必须晚于提交时间2小时； 如果通过格式无法识别时区，默认以**UTC**时间为准。 |
| remark          | string | No   | null | 备注说明，最大长度限制为500，**需要urlencode处理。**         |
| owner           | string | No   | null | 稿件所属客户，最大长度限制为100，**需要urlencode处理。**     |

| 名称       | 类型   | 说明                   |
| :--------- | :----- | :--------------------- |
| partner_sn | string | 超级媒介订单号（26位） |



## 新闻媒体订单催稿

请求路径：/media/order/urge

请求方式：POST

| 名称 | 类型   | 必填 | 默认 | 说明         |
| :--- | :----- | :--- | :--- | :----------- |
| sn   | string | Yes  | -    | 代理商订单号 |



## 新闻媒体订单取消

只有状态为待处理的订单才可取消。

请求路径：/media/order/cancel

请求方式：POST

| 名称   | 类型   | 必填 | 默认 | 说明           |
| :----- | :----- | :--- | :--- | :------------- |
| sn     | string | Yes  | -    | 代理商订单号   |
| reason | string | Yes  | -    | 取消原因或理由 |



## 新闻媒体订单申请退款

如果在发布中申请退款，不保证一定退款成功，最终以编辑为准。

请求路径：/media/order/apply-refund

请求方式：POST

| 名称   | 类型   | 必填 | 默认 | 说明           |
| :----- | :----- | :--- | :--- | :------------- |
| sn     | string | Yes  | -    | 代理商订单号   |
| reason | string | Yes  | -    | 退款原因或理由 |



## 新闻媒体订单申请补发

仅支持包收录资源订单，在未被收录且在有效时间段内时（发布或补发后：12小时~7天），才可以申请补发。

请求路径：/media/order/apply-republish

请求方式：POST

| 名称 | 类型   | 必填 | 默认 | 说明         |
| :--- | :----- | :--- | :--- | :----------- |
| sn   | string | Yes  | -    | 代理商订单号 |



## 查询新闻媒体订单

请求路径：/media/order/query

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                                       |
| :--- | :--- | :--- | :--- | :----------------------------------------- |
| sn   | list | Yes  | -    | 代理商新闻媒体订单号列表，最大长度限制为20 |

| 名称         | 类型         | 说明                                                         |
| :----------- | :----------- | :----------------------------------------------------------- |
| sn           | string       | 代理商新闻媒体订单号                                         |
| url          | string\|null | 发布网址，未发布时为null                                     |
| screenshot   | string\|null | 发布截图HTML内容，由于数据来自用户，请在展示时考虑XSS，CSRF等安全问题。 |
| published_at | date\|null   | 发布时间，未发布时为null                                     |
| status       | int          | 状态，参见[附录：订单状态](https://vip.chaojimeijie.com/agent/document#appendix:order:status) |
| feedback     | dict\|null   | 订单最后一步操作反馈数据，因订单状态而异，参见[附录：订单反馈信息](https://vip.chaojimeijie.com/agent/document#appendix:feedback) |



## 获取自媒体资源

请求路径：/we-media/resource

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                    |
| :--- | :--- | :--- | :--- | :---------------------- |
| page | int  | No   | 1    | 页码                    |
| size | int  | No   | 20   | 每页个数，最大限制为200 |

| 名称  | 类型 | 说明     |
| :---- | :--- | :------- |
| total | int  | 资源总数 |
| items | list | 资源列表 |

| 名称              | 类型          | 说明                                                         |
| :---------------- | :------------ | :----------------------------------------------------------- |
| id                | int           | 资源标识                                                     |
| name              | string        | 资源名称                                                     |
| entrance_link     | string\|null  | 入口链接                                                     |
| case_link         | string        | 案例链接                                                     |
| remark            | string\|null  | 备注说明                                                     |
| price             | decimal(10,2) | 图文成本价格，单位：元                                       |
| video_price       | decimal(10,2) | 视频成本价格，单位：元                                       |
| trend_price       | decimal(10,2) | 动态（微头条）成本价格，单位：元                             |
| published_avg     | int           | 平均发稿时间，单位：分钟                                     |
| published_rate    | int           | 发稿率，0 ~ 100                                              |
| platform          | int           | 所属平台，参见[附录：所属平台](https://vip.chaojimeijie.com/agent/document#appendix:platform) |
| area              | int           | 所属地区                                                     |
| industry_category | int           | 行业分类，参见[附录：行业分类](https://vip.chaojimeijie.com/agent/document#appendix:industry_category) |
| fans_number       | int           | 参考粉丝数， 1: 0-1000 2: 1001-5000 3: 5001-1万 4: 1万-5万 5: 5万-10万 6: 10万-100万 7: 100万-500万 8: 500万-1000万 9: 1000万以上 |
| read_number       | int           | 参考阅读数， 1: 0-1000 2: 1001-5000 3: 5001-1万 4: 1万-5万 5: 5万-10万 6: 10万以上 |
| like_number       | int           | 参考点赞数， 1: 0-1000 2: 1001-5000 3: 5001-1万 4: 1万-5万 5: 5万-10万 6: 10万以上 |
| publish_daily     | int           | 每日可发篇数， 1: 1篇 2: 2篇 3: 3篇 5: 5篇 10: 10篇 255: 不限量篇 |
| is_authenticated  | boolean       | 是否已认证                                                   |
| is_official       | boolean       | 是否为官方自媒体                                             |
| can_video         | boolean       | 是否支持发视频                                               |
| can_trend         | boolean       | 是否支持发动态（微头条）                                     |
| can_weekend       | boolean       | 周末是否可以发稿                                             |
| status            | int           | 状态，参见[附录：资源状态](https://vip.chaojimeijie.com/agent/document#appendix:resource:status) |



## 查询自媒体资源

请求路径：/we-media/resource/query

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                          |
| :--- | :--- | :--- | :--- | :---------------------------- |
| id   | list | Yes  | -    | 资源id列表，最大长度限制为200 |

响应数据data为有效资源列表，详情数据字段说明与[**获取自媒体资源**](https://vip.chaojimeijie.com/agent/document#/we-media/resource)接口返回的data['items']列表一致。



## 创建自媒体订单

请求路径：/we-media/order

请求方式：POST

| 名称                | 类型     | 必填   | 默认     | 说明                                                         |
| :------------------ | :------- | :----- | :------- | :----------------------------------------------------------- |
| sn                  | string   | Yes    | -        | 代理商订单号，必须唯一且最大长度限制为64                     |
| resource_id         | int      | Yes    | -        | 资源id                                                       |
| title               | string   | Yes    | -        | 稿件标题，最大长度限制为200，**需要urlencode处理。**         |
| content             | string   | Yes    | -        | 稿件内容预览地址，必须为正确的URL格式，**需要urlencode处理。** |
| ~~publish_limited~~ | ~~date~~ | ~~No~~ | ~~null~~ | ~~限时发布时间，必须为正确的时间格式，推荐格式：**"Y-m-d\TH:i:sP"**； 必须晚于提交时间2小时； 如果通过格式无法识别时区，默认以**UTC**时间为准。~~ **自2026年4月10日起，自媒体不再支持限时发布。** |
| remark              | string   | No     | null     | 备注说明，最大长度限制为500，**需要urlencode处理。**         |
| owner               | string   | No     | null     | 稿件所属客户，最大长度限制为100，**需要urlencode处理。**     |
| publish_form        | int      | Yes    | -        | 发布形式1: 图文发布 2: 优先图文发布，未通过则截图发布        |
| publish_type        | int      | Yes    | -        | 发布类型1: 图文 2: 视频 3: 动态                              |
| account_rule        | int      | Yes    | -        | 发布规则2: 只允许更换同类型账号发布 3: 不允许换号发布        |

| 名称       | 类型   | 说明                   |
| :--------- | :----- | :--------------------- |
| partner_sn | string | 超级媒介订单号（26位） |



## 自媒体订单催稿

请求路径：/we-media/order/urge

请求方式：POST

| 名称 | 类型   | 必填 | 默认 | 说明         |
| :--- | :----- | :--- | :--- | :----------- |
| sn   | string | Yes  | -    | 代理商订单号 |



## 自媒体订单取消

只有状态为待处理的订单才可取消。

请求路径：/we-media/order/cancel

请求方式：POST

| 名称   | 类型   | 必填 | 默认 | 说明           |
| :----- | :----- | :--- | :--- | :------------- |
| sn     | string | Yes  | -    | 代理商订单号   |
| reason | string | Yes  | -    | 取消原因或理由 |



## 自媒体订单申请退款

如果在发布中申请退款，不保证一定退款成功，最终以编辑为准。

请求路径：/we-media/order/apply-refund

请求方式：POST

| 名称   | 类型   | 必填 | 默认 | 说明           |
| :----- | :----- | :--- | :--- | :------------- |
| sn     | string | Yes  | -    | 代理商订单号   |
| reason | string | Yes  | -    | 退款原因或理由 |



## 查询自媒体订单

请求路径：/we-media/order/query

请求方式：GET

| 名称 | 类型 | 必填 | 默认 | 说明                                     |
| :--- | :--- | :--- | :--- | :--------------------------------------- |
| sn   | list | Yes  | -    | 代理商自媒体订单号列表，最大长度限制为20 |

| 名称         | 类型         | 说明                                                         |
| :----------- | :----------- | :----------------------------------------------------------- |
| sn           | string       | 代理商自媒体订单号                                           |
| url          | string\|null | 发布网址，未发布时为null                                     |
| screenshot   | string\|null | 发布截图HTML内容，由于数据来自用户，请在展示时考虑XSS，CSRF等安全问题。 |
| published_at | date\|null   | 发布时间，未发布时为null                                     |
| status       | int          | 状态，参见[附录：订单状态](https://vip.chaojimeijie.com/agent/document#appendix:order:status) |
| feedback     | dict\|null   | 订单最后一步操作反馈数据，因订单状态而异，参见[附录：订单反馈信息](https://vip.chaojimeijie.com/agent/document#appendix:feedback) |



## 事件通知

数据签名方式与请求接口时相同

回调地址：用户设置的**事件通知URL**

回调方式：POST

| 名称    | 类型 | 必填 | 说明                                         |
| :------ | :--- | :--- | :------------------------------------------- |
| event   | int  | Yes  | 事件类型， 1: 资源变更 2: 订单变更           |
| payload | dict | Yes  | 事件数据，因事件类型不同而异，具体见下方说明 |

| 名称 | 类型 | 必填 | 说明                                                       |
| :--- | :--- | :--- | :--------------------------------------------------------- |
| type | int  | Yes  | 资源类型， 1: 新闻媒体 2: 自媒体                           |
| id   | int  | Yes  | 资源id，可以通过以此参数调用资源查询接口来更新本地资源数据 |

| 名称 | 类型   | 必填 | 说明                                                         |
| :--- | :----- | :--- | :----------------------------------------------------------- |
| type | int    | Yes  | 资源类型， 1: 新闻媒体 2: 自媒体                             |
| sn   | string | Yes  | 代理商订单号，可以通过以此参数调用订单查询接口来更新本地订单数据 |



## 附录：所属地区

| 值   | 标签     |
| :--- | :------- |
| 100  | 综合全国 |
| 1    | 北京     |
| 2    | 天津     |
| 3    | 上海     |
| 4    | 重庆     |
| 5    | 河北     |
| 6    | 山西     |
| 7    | 辽宁     |
| 8    | 吉林     |
| 9    | 黑龙江   |
| 10   | 江苏     |
| 11   | 浙江     |
| 12   | 安徽     |
| 13   | 福建     |
| 14   | 江西     |
| 15   | 山东     |
| 16   | 河南     |
| 17   | 湖北     |
| 18   | 湖南     |
| 19   | 广东     |
| 20   | 甘肃     |
| 21   | 四川     |
| 22   | 贵州     |
| 23   | 海南     |
| 24   | 云南     |
| 25   | 青海     |
| 26   | 陕西     |
| 27   | 新疆     |
| 28   | 宁夏     |
| 29   | 内蒙古   |
| 30   | 西藏     |
| 31   | 广西     |
| 32   | 港澳台   |
| 33   | 海外     |



## 附录：频道类型

| 值   | 标签     |
| :--- | :------- |
| 1    | IT科技   |
| 2    | 生活消费 |
| 3    | 女性时尚 |
| 4    | 娱乐休闲 |
| 5    | 游戏网站 |
| 6    | 汽车网站 |
| 7    | 教育培训 |
| 8    | 酒店旅游 |
| 9    | 健康医疗 |
| 10   | 房产家居 |
| 11   | 财经商业 |
| 12   | 新闻资讯 |
| 13   | 套餐系列 |
| 14   | 最新秒杀 |
| 15   | 十元专区 |
| 16   | 文化艺术 |
| 17   | 体育运动 |
| 18   | 食品餐饮 |
| 19   | 工业贸易 |
| 20   | 亲子母婴 |
| 21   | 慈善公益 |
| 100  | 其他频道 |



## 附录：综合门户

| 值   | 标签           |
| :--- | :------------- |
| 1    | 新浪网         |
| 2    | 搜狐网         |
| 3    | 腾讯网         |
| 4    | 网易网         |
| 5    | 凤凰网         |
| 6    | 中华网         |
| 7    | 人民网         |
| 8    | 央视网         |
| 9    | 千龙网         |
| 10   | 新华网         |
| 11   | 中国网         |
| 12   | 慧聪网         |
| 13   | 大众网         |
| 14   | 东方网         |
| 15   | 中国日报网     |
| 16   | 中国经济网     |
| 17   | 中国新闻网     |
| 18   | 中国广播网     |
| 19   | 和讯网         |
| 20   | 北青网         |
| 21   | 光明网         |
| 22   | 环球网         |
| 23   | 国际在线       |
| 24   | 中国青年网     |
| 25   | 人民日报客户端 |
| 27   | 官方百家号     |
| 29   | 垂直媒体       |
| 30   | 其他门户       |
| 31   | 海外媒体       |



## 附录：所属平台

| 值   | 标签       |
| :--- | :--------- |
| 1    | 腾讯号     |
| 2    | 哔哩哔哩   |
| 3    | 网易号     |
| 4    | 搜狐网     |
| 5    | 百家号     |
| 6    | 今日头条   |
| 7    | 微博       |
| 8    | 一点资讯   |
| 9    | 新浪号     |
| 10   | 小红书     |
| 11   | 知乎号     |
| 12   | zaker      |
| 13   | 豆瓣       |
| 14   | UC头条     |
| 15   | 东方头条   |
| 16   | 东方财富号 |
| 17   | 车家号     |
| 18   | 中金在线号 |
| 19   | 雪球号     |
| 20   | 凤凰号     |
| 21   | 微信公众号 |
| 23   | 简书       |
| 24   | 懂车帝     |
| 22   | 其他       |



## 附录：行业分类

| 值   | 标签 |
| :--- | :--- |
| 1    | 文化 |
| 2    | 历史 |
| 3    | 三农 |
| 4    | 财经 |
| 5    | 科技 |
| 6    | 体育 |
| 7    | 汽车 |
| 8    | 娱乐 |
| 9    | 时尚 |
| 10   | 健康 |
| 11   | 教育 |
| 12   | 母婴 |
| 13   | 美食 |
| 14   | 旅游 |
| 15   | 公益 |
| 16   | 游戏 |
| 17   | 动漫 |
| 18   | 社会 |
| 19   | 房产 |
| 20   | 职场 |
| 21   | 情感 |
| 22   | 搞笑 |
| 23   | 新闻 |
| 24   | 家居 |
| 25   | 生活 |
| 100  | 其他 |



## 附录：资源状态

除了**已通过**之外，其他均表示未上架

| 状态 | 标签   |
| :--- | :----- |
| 1    | 审核中 |
| 2    | 已通过 |
| 3    | 未通过 |
| 4    | 已暂停 |
| 5    | 已取消 |



## 附录：订单状态

**补发中**、**已补发**、**已收录**三种状态为新闻媒体订单所独有。

| 值   | 标签     |
| :--- | :------- |
| 1    | 待处理   |
| 2    | 已拒稿   |
| 3    | 发布中   |
| 4    | 已发布   |
| 5    | 已取消   |
| 6    | 退款中   |
| 7    | 已退款   |
| 8    | 退款被拒 |
| 9    | 已关闭   |
| 10   | 补发中   |
| 11   | 已补发   |
| 12   | 已收录   |



## 附录：订单反馈信息

当订单状态为**待处理**、**发布中**、**已退款**时，feedback值为null。其他状态见下表：

| 名称   | 类型   | 说明             |
| :----- | :----- | :--------------- |
| reason | string | 操作的原因或理由 |

| 名称       | 类型   | 说明                                                         |
| :--------- | :----- | :----------------------------------------------------------- |
| url        | string | 发布网址                                                     |
| screenshot | string | 发布截图HTML内容，由于数据来自用户，请在展示时考虑XSS，CSRF等安全问题。 |

| 名称       | 类型   | 说明                                                         |
| :--------- | :----- | :----------------------------------------------------------- |
| screenshot | string | 收录截图HTML内容，由于数据来自用户，请在展示时考虑XSS，CSRF等安全问题。 |