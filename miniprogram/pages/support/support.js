var D = require("../../utils/data.js");
var chat = require("../../utils/chat.js");

Page({
  data: {
    sup: "talk",
    roles: D.ROLES,
    role: "parent",
    msgs: [],
    chips: D.CHAT_CHIPS.parent,
    draft: "",
    busy: false,
    scrollInto: "",
    helpSigns: D.HELP_SIGNS,
    helpPaths: D.HELP_PATHS
  },
  onLoad: function () {
    this._mid = 0;
    this._chat = chat.newChat("parent");
    this.pushMsgs(this._chat.msgs);
  },
  onShow: function () {
    var g = getApp().globalData;
    if (g.sup) {
      this.setData({ sup: g.sup });
      g.sup = null;
    }
  },
  pushMsgs: function (list) {
    var that = this;
    var withId = list.map(function (m) {
      that._mid += 1;
      return Object.assign({}, m, { id: "m" + that._mid });
    });
    var msgs = this.data.msgs.concat(withId);
    if (msgs.length > 60) msgs = msgs.slice(-60);
    this.setData({ msgs: msgs, scrollInto: withId[withId.length - 1].id });
  },
  onSup: function (e) { this.setData({ sup: e.currentTarget.dataset.k }); },
  onRole: function (e) {
    var role = e.currentTarget.dataset.k;
    this._chat = chat.newChat(role);
    this._mid = 0;
    this.setData({ role: role, chips: D.CHAT_CHIPS[role], msgs: [], busy: false, draft: "" });
    this.pushMsgs(this._chat.msgs);
  },
  onDraft: function (e) { this.setData({ draft: e.detail.value }); },
  onChip: function (e) { this.send(e.currentTarget.dataset.t); },
  onConfirm: function (e) { this.send(e.detail.value); },
  onSend: function () { this.send(this.data.draft); },
  send: function (text) {
    text = String(text || "").trim();
    if (!text || this.data.busy) return;
    var that = this;
    this.pushMsgs([{ who: "user", text: text }]);
    this.setData({ busy: true, draft: "" });
    setTimeout(function () {
      that.pushMsgs([chat.reply(that._chat, that.data.role, text)]);
      that.setData({ busy: false });
    }, 550 + Math.random() * 450);
  },
  onSit: function (e) { wx.navigateTo({ url: "/pages/situation/situation?id=" + e.currentTarget.dataset.id }); },
  onHelp: function () { this.setData({ sup: "help" }); },
  callHelp: function () { wx.makePhoneCall({ phoneNumber: "12356" }); }
});