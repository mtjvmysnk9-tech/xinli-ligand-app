var D = require("./data.js");

function newChat(role) {
  return {
    msgs: [{ who: "bot", lead: D.CHAT_GREET[role], follow: D.CHAT_HINT[role] }],
    lastTopic: null,
    depth: 0
  };
}

function matchTopic(text) {
  var best = null, bestScore = 0;
  D.CHAT_TOPICS.forEach(function (t) {
    var score = 0;
    t.kws.forEach(function (k) { if (text.indexOf(k) !== -1) score++; });
    if (score > bestScore) { best = t; bestScore = score; }
  });
  return best;
}

function reply(state, role, text) {
  var lower = text.toLowerCase();
  if (/不想活|想死|自杀|自伤|伤害自己|割腕|活着没意思|结束生命/.test(lower)) {
    state.lastTopic = null; state.depth = 0;
    return { who: "bot", crisis: true,
      lead: "谢谢你告诉我这些。这句话很重要，我会认真对待。如果你或孩子现在有伤害自己的念头，请现在就行动，不要等待：",
      dos: ["立即陪在他身边，不要让他独处，收好危险物品", "马上联系家长、学校心理老师或医生，不要替他保密", "拨打 12356 心理援助热线；有紧急危险时拨打 120 / 110"],
      follow: "这不是软弱，也不是「想不开」，而是需要专业帮助的时刻。你愿意现在就去联系身边的人吗？" };
  }
  if (/谢谢|感谢|有用|帮到我/.test(lower)) {
    return { who: "bot", lead: "不客气。陪伴本身就是最有力量的支持。之后遇到新的情况，随时回来聊。也记得照顾好你自己的情绪。" };
  }
  if (/^(你好|在吗|hi|hello|您好)[!！。？?]*$/.test(lower)) {
    return { who: "bot", lead: D.CHAT_GREET[role], follow: D.CHAT_HINT[role] };
  }
  var t = matchTopic(lower);
  if (t && t.id === state.lastTopic && state.depth >= 1) t = null;
  if (!t && state.lastTopic && (text.length <= 15 || /嗯|然后|还有|继续|具体|怎么办|呢|吗/.test(lower))) {
    var prev = D.CHAT_TOPICS.filter(function (x) { return x.id === state.lastTopic; })[0];
    if (prev) { state.depth = 2; return { who: "bot", lead: "我们再往深走一步：", dos: prev.more, follow: "试了之后情况怎么样？随时回来告诉我，我们再调整。" }; }
  }
  if (t) {
    state.lastTopic = t.id; state.depth = 1;
    var sitId = t.sit && t.sit[role] ? t.sit[role] : null;
    return { who: "bot", lead: t.lead, dos: t.dos, avoid: t.avoid, say: t.say[role], follow: t.follow, sit: sitId };
  }
  return { who: "bot", lead: "我听到了，这确实不容易。能多说一点吗：这种情况持续多久了？你最希望改变的是什么？", follow: "也可以点下面的快捷提问，或直接描述一个具体场景，比如「孩子练完回来就发脾气」。" };
}

module.exports = { newChat: newChat, reply: reply };