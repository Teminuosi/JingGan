# 博客账号与镜感登录

镜感复用三月导航的 Supabase 邮箱账号。已有博客账号直接使用同一邮箱、密码登录；镜感注册也创建同一套账号。两个站点的浏览器登录会话独立，本版没有跨域自动登录。

## 本地配置

在项目根目录参考 `.env.example` 配置 `.env.local`。仅使用 Supabase 公开客户端 Key，禁止填写 service_role 或私密管理员 Key。

| 配置 | 用途 |
| --- | --- |
| `SUPABASE_URL` | 博客同一 Supabase 项目的 HTTPS 地址 |
| `SUPABASE_PUBLISHABLE_KEY` | publishable Key 或 role=anon 的旧公开 Key |
| `MIRROR_AUTH_ENABLED` | 默认启用登录；配置缺失时不放行 |
| `MIRROR_BLOG_URL` | 账号信息、找回密码及邮件验证返回博客的地址 |
| `MIRROR_LOCAL_CLAIMS` | 本机旧项目认领开关；只在非生产 localhost、同源请求下生效 |
| `MIRROR_RELAY_REFERRAL_URL` | 可选的获取 Key 链接，收在设置折叠区；留空不展示推荐链接 |

Supabase 需允许邮箱密码登录；`profiles` 应由博客既有注册机制建立，并允许当前用户读取自己的 `is_banned`。缺少个人资料、被封禁或认证服务异常均不会放行。邮件确认是否必需取决于 Supabase 设置；需要确认时，注册完成后先提示查收邮件，不直接进入工作台。生产部署需配置同名环境变量与邮件允许返回地址，不能上传本地 `.env.local`。

根目录命令：`npm install` 安装依赖；`npm run dev` 使用现有本地启动器；`npm run build` 构建；`npm run start` 启动构建产物。启动器仍包含项目原有本机服务，不代表 Cloudflare 云部署能运行本机 Blender。

## 账号、来源与旧数据

- 登录状态使用 HttpOnly、SameSite=Lax Cookie；HTTPS 下加 Secure。服务端验证真实用户，不信任自报身份头。
- 登录、注册、刷新和退出在支持 Web Locks 的浏览器中跨标签页串行处理；退出等待在途刷新完成再清 Cookie。镜感退出不会退出博客。
- 注册支持 `?source=github`、`blog`、`bilibili`、`douyin`，默认 `jinggan`。来源规范化后写新账号 `register_source`；既有博客来源不覆盖。镜感首次使用另记录在 D1 `account_visits`，没有改动博客后台展示。
- 项目与素材接口按账号所有权访问。头像菜单可认领本机旧项目；只更新所有者，不更换项目 ID、资产键或移动图片。共享电脑需自行核对归属。
- API Key、最近项目指针、任务缓存按账号保存在当前浏览器。旧 Key 需在 AI 服务设置显式导入；不会由匿名用户或另一账号自动继承。浏览器本地 Key 不是加密保险箱，也不会同步到其他设备。
- 跨标签页账号变化会阻止旧账号配置提交；已开始的任务结果继续归原账号缓存。付费 POST 失败不会自动重新提交。

## 获取模型 Key

用户自行去模型服务商注册、充值、创建个人 Key，再粘贴到镜感的“AI 服务设置”。镜感账号与模型服务账号独立；镜感注册不会自动充值或领取 Key。服务地址在高级设置中，推广链接和步骤默认折叠。

## 验证和开源边界

根目录 `npm run test:auth` 使用模拟认证和内存 SQLite，覆盖匿名/伪造身份、封禁、认证故障、Cookie、来源、项目认领、跨账号 Key/缓存隔离和退出刷新顺序；不创建真实账号，不调用收费模型。`npm test` 覆盖原有契约、故事、角色、Relay、管线与 Mock 烟测；`npx tsc --noEmit`、`npm run lint`、`npm run build` 检查类型、代码和构建。

真实邮箱注册、邮件验证、已有博客账号登录、真实账号的旧项目认领和收费生成尚需使用者验收；不要把 Mock 测试通过视为这些链路已实测。

官方配置默认要求登录；开源副本需要自行配置认证及存储。MIT 开源不能保证分叉者保留登录、来源或推荐入口。本机预演助手仍按原有本机票据运行，不能把 UI 登录限制称为该助手的远端账号鉴权。本轮没有发布 GitHub或修改线上博客数据库。
