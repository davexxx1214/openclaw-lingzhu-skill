// 请从开者中心获取 "Client-end (Target Recognition) URL"，
// 格式如：https://af0c1ca3b........0601c74.cn1.crs.easyar.com:8443
const app = new App('https://bd7b474c2b47e946c9c7f12ec3e220b9.cn1.crs.easyar.com:8443');

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
        video: '//staticfile-cdn.sightp.com/sightp/webar/webardemo-final.mp4',
    };

    // 可以将 setting 作为meta上传到EasyAR的云识别，使用方法如下:
    // const setting = JSON.parse(window.atob(msg.target.meta));

    playVideo(setting);
};

// 在手机上可能不会自动播放
function playVideo(setting: any): void {
    let video: HTMLVideoElement = document.querySelector('#easyARVideo');
    if (video === null) {
        video = document.createElement('video');
        video.setAttribute('id', 'easyARVideo');
        video.setAttribute('controls', 'controls');
        video.setAttribute('playsinline', 'playsinline');
        video.setAttribute('preload', 'preload');
        video.setAttribute('style', 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:99');
        document.querySelector('#easyAR').appendChild(video);
    }

    video.setAttribute('src', setting.video);
    video.play().then(() => {
    }).catch((err) => {
        // 需要使用点击事件播放。
        console.info('播放视频失败');
        console.info(err);
    });
}
