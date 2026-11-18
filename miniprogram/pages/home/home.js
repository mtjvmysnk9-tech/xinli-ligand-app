var D = require("../../utils/data.js");

Page({
  data: {
    moods: D.MOODS,
    modules: D.MODULES
  },
  onMood: function (e) {
    getApp().globalData.mood = Number(e.currentTarget.dataset.i);
    wx.switchTab({ url: "/pages/journal/journal" });
  },
  onMod: function (e) {
    var key = e.currentTarget.dataset.key;
    var g = getApp().globalData;
    if (key === "check") wx.switchTab({ url: "/pages/check/check" });
    else if (key === "journal") wx.switchTab({ url: "/pages/journal/journal" });
    else if (key === "stories") { g.disc = "stories"; wx.switchTab({ url: "/pages/discover/discover" }); }
    else if (key === "science") { g.disc = "science"; wx.switchTab({ url: "/pages/discover/discover" }); }
    else if (key === "talk") { g.sup = "talk"; wx.switchTab({ url: "/pages/support/support" }); }
    else if (key === "help") { g.sup = "help"; wx.switchTab({ url: "/pages/support/support" }); }
  }
});