var D = require("../../utils/data.js");

Page({
  data: {
    disc: "stories",
    stories: D.STORIES,
    videos: D.VIDEOS,
    articles: D.ARTICLES
  },
  onShow: function () {
    var g = getApp().globalData;
    if (g.disc) {
      this.setData({ disc: g.disc });
      g.disc = null;
    }
  },
  onDisc: function (e) { this.setData({ disc: e.currentTarget.dataset.k }); },
  onStory: function (e) { wx.navigateTo({ url: "/pages/story/story?id=" + e.currentTarget.dataset.id }); },
  onArticle: function (e) { wx.navigateTo({ url: "/pages/article/article?id=" + e.currentTarget.dataset.id }); },
  onVideo: function (e) {
    var v = D.VIDEOS.filter(function (x) { return x.id === e.currentTarget.dataset.id; })[0];
    if (!v) return;
    var url = "https://www.bilibili.com/video/" + v.bvid;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showModal({
          title: "链接已复制",
          content: "小程序内暂无法直接嵌入 B 站播放器。请粘贴到浏览器或 B 站 App 打开；网页版「心里韧带」可直接播放。",
          showCancel: false,
          confirmText: "知道了"
        });
      }
    });
  }
});