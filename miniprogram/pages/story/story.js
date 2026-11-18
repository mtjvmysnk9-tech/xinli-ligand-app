var D = require("../../utils/data.js");

Page({
  data: { story: null },
  onLoad: function (options) {
    var s = D.STORIES.filter(function (x) { return x.id === options.id; })[0] || null;
    this.setData({ story: s });
    if (s) wx.setNavigationBarTitle({ title: "真实故事" });
  },
  onSource: function (e) {
    var url = e.currentTarget.dataset.url;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showModal({ title: "链接已复制", content: "报道来源链接已复制，请粘贴到浏览器查看原文。", showCancel: false, confirmText: "知道了" });
      }
    });
  },
  goJournal: function () { wx.switchTab({ url: "/pages/journal/journal" }); }
});