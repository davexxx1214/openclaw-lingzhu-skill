// 请从开者中心获取 "Client-end (Target Recognition) URL"，
// 格式如：https://af0c1ca3b........0601c74.cn1.crs.easyar.com:8443
const app = new App('Client-end (Target Recognition) URL');

// 如果使用自定义方法获取token
// app.setToken({
//     'crsAppId': '', // 云别库的CRS AppId
//     'token': '' // APIKey+APISecret生成token
// });

// 如果使用EasyAR提供的集成环境
app.useEasyAr();

// 识别成功后的回调
app.callback = (msg) => {
    console.info(msg);
    const setting = {
        model: 'asset/model/trex_v3.fbx',
        scale: 0.02,
        position: [0, 0, 0]
    };

    // 可以将 setting 作为meta上传到EasyAR的云识别，使用方法如下:
    // const setting = JSON.parse(window.atob(msg.target.meta));

    showModel(setting);
};

function showModel(setting: any): void {
    const canvas = document.querySelector('.easyARCanvas');
    if (canvas) {
        canvas.remove();
    }

    app.show('loadingWrap');

    // ThreeJS简单使用类
    const threeHelper = new ThreeHelper();
    threeHelper.loadObject(setting, (p) => {
        const val = Math.ceil(p.loaded / p.total * 100);
        document.querySelector('#loadingPercent').innerHTML = `${val}%`;
        if (val >= 100) {
            app.hide('loadingWrap');
        }
    });
}
