# EasyAR WebAR 简介

WebAR，由全球领先的AR开放平台和AR技术领导者视+AR针对Web平台（如微信、Safari浏览器）开发的全新AR产品。
WebAR由Web前端和EasyAR云服务组成，支持平面图片识别、云识别、3D渲染、复杂互动等功能。 WebAR具有模式轻、部署快、传播性强等特点。

EasyAR 官网地址： https://www.easyar.cn https://www.easyar.com

技术支持：support@easyar.com



## EasyAR WebAR 集成运行包

为方便开发者快速搭建开发环境，EasyAR-WebAR_*为集成运行包，　集成 http 服务及 token 生成服务。

### 文件及目录说明

EasyAR-WebAR_* 文件为 http 及 token 生成服务，如果你会配置 http 服务及 token生成，请忽略此部分。

* EasyAR-WebAR_linux：linux系统程序
* EasyAR-WebAR_darwin：Mac OS系统程序
* EasyAR-WebAR_windows.exe：windows系统程序
* config/application.txt程序配置(JSON格式)
    * port：程序监听端口
    * apiKey：EasyAR API Key
    * apiSecret：EasyAR API Secret
    * crsAppId：EasyAR 云识别库 Crs AppId
* html：HTML、JS等文件目录

### 开发使用

1. 修改config/application.txt
    
    将你的云识别API Key, API Secret及Crs AppId填入。

2. 开启HTTP服务

   运行EasyAR-WebAR程序，如启动成功，会显示监听的端口号。
   * linux系统：
       ```shell
       ./EasyAR-WebAR_linux
       ```
   * Mac OS系统：
       ```shell
       ./EasyAR-WebAR_darwin
       ```
   * windows系统：
       ```
       鼠标双击或在cmd中运行：EasyAR-WebAR_windows.exe
       ```
3. 访问示例
    在 PC 浏览器(需要摄像头)中输入 http://127.0.0.1:3000/<demo目录>,
    如：http://127.0.0.1:3000/TokenVideoExample，建议使用火狐浏览器。

4. 如果一切顺利，第一个Demo将会呈现在你的浏览器中。

5. 如果集成包不能运行,请参考如 nginx 等配置运行环境。

## 四、集成到生产环境

域名必须支持 HTTPS 协议

### 1. 与 nginx 集成

在 nginx 配置文件中的 server 中，添加以下内容：

``` 
location / {
    index  index.html;
    proxy_pass   http://127.0.0.1:3000/;
}     
```

### 2. 自定义方式生成 token

请参考官网文档: https://www.easyar.cn
    
## 五、祝一切顺利

