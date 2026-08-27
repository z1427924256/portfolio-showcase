import { json } from '../_lib';

// 省级行政区（ISO 3166-2 regionCode → 中文）
const PROVINCES = {
  BJ: '北京', TJ: '天津', HE: '河北', SX: '山西', NM: '内蒙古',
  LN: '辽宁', JL: '吉林', HL: '黑龙江', SH: '上海', JS: '江苏',
  ZJ: '浙江', AH: '安徽', FJ: '福建', JX: '江西', SD: '山东',
  HA: '河南', HB: '湖北', HN: '湖南', GD: '广东', GX: '广西',
  HI: '海南', CQ: '重庆', SC: '四川', GZ: '贵州', YN: '云南',
  XZ: '西藏', SN: '陕西', GS: '甘肃', QH: '青海', NX: '宁夏',
  XJ: '新疆', HK: '香港', MO: '澳门', TW: '台湾',
};

// 国家代码 → 中文（常见）
const COUNTRIES = {
  CN: '中国', US: '美国', JP: '日本', KR: '韩国', SG: '新加坡',
  GB: '英国', DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚',
  RU: '俄罗斯', IN: '印度', TH: '泰国', VN: '越南', MY: '马来西亚',
  ID: '印度尼西亚', PH: '菲律宾', NL: '荷兰', IT: '意大利', ES: '西班牙',
  BR: '巴西', AE: '阿联酋', NZ: '新西兰', SE: '瑞典', CH: '瑞士',
  MO: '澳门', HK: '香港', TW: '台湾', UA: '乌克兰', TR: '土耳其',
};

// 城市（拼音 → 中文），按省分组（避免同名城市冲突，如福州/抚州、泰州/台州、玉林/榆林）
const CITIES = {
  BJ: { Beijing: '北京' },
  TJ: { Tianjin: '天津' },
  SH: { Shanghai: '上海' },
  CQ: { Chongqing: '重庆', Yubei: '渝北', Jiangbei: '江北', "Nan'an": '南岸', Banan: '巴南' },
  HE: { Shijiazhuang: '石家庄', Tangshan: '唐山', Qinhuangdao: '秦皇岛', Handan: '邯郸', Xingtai: '邢台', Baoding: '保定', Zhangjiakou: '张家口', Chengde: '承德', Cangzhou: '沧州', Langfang: '廊坊', Hengshui: '衡水' },
  SX: { Taiyuan: '太原', Datong: '大同', Yangquan: '阳泉', Changzhi: '长治', Jincheng: '晋城', Shuozhou: '朔州', Jinzhong: '晋中', Yuncheng: '运城', Xinzhou: '忻州', Linfen: '临汾', Lüliang: '吕梁', Luliang: '吕梁' },
  NM: { Hohhot: '呼和浩特', Baotou: '包头', Wuhai: '乌海', Chifeng: '赤峰', Tongliao: '通辽', Hulunbuir: '呼伦贝尔', Bayannur: '巴彦淖尔', Ordos: '鄂尔多斯', Ulanqab: '乌兰察布', 'Xing\'an': '兴安', Alxa: '阿拉善', Xilingol: '锡林郭勒', Erenhot: '二连浩特' },
  LN: { Shenyang: '沈阳', Dalian: '大连', Anshan: '鞍山', Fushun: '抚顺', Benxi: '本溪', Dandong: '丹东', Jinzhou: '锦州', Yingkou: '营口', Fuxin: '阜新', Liaoyang: '辽阳', Panjin: '盘锦', Tieling: '铁岭', Chaoyang: '朝阳', Huludao: '葫芦岛' },
  JL: { Changchun: '长春', Jilin: '吉林', Siping: '四平', Liaoyuan: '辽源', Tonghua: '通化', Baishan: '白山', Songyuan: '松原', Baicheng: '白城', Yanbian: '延边' },
  HL: { Harbin: '哈尔滨', Qiqihar: '齐齐哈尔', Jixi: '鸡西', Hegang: '鹤岗', Shuangyashan: '双鸭山', Daqing: '大庆', Yichun: '伊春', Jiamusi: '佳木斯', Qitaihe: '七台河', Mudanjiang: '牡丹江', Heihe: '黑河', Suihua: '绥化', 'Daxing\'anling': '大兴安岭', Daxinganling: '大兴安岭' },
  JS: { Nanjing: '南京', Wuxi: '无锡', Xuzhou: '徐州', Changzhou: '常州', Suzhou: '苏州', Nantong: '南通', Lianyungang: '连云港', "Huai'an": '淮安', Huaian: '淮安', Yancheng: '盐城', Yangzhou: '扬州', Zhenjiang: '镇江', Taizhou: '泰州', Suqian: '宿迁', Kunshan: '昆山', Zhangjiagang: '张家港', Changshu: '常熟' },
  ZJ: { Hangzhou: '杭州', Ningbo: '宁波', Wenzhou: '温州', Jiaxing: '嘉兴', Huzhou: '湖州', Shaoxing: '绍兴', Jinhua: '金华', Quzhou: '衢州', Zhoushan: '舟山', Taizhou: '台州', Lishui: '丽水', Yiwu: '义乌', Cixi: '慈溪', Zhuji: '诸暨', Ruian: '瑞安', Yueqing: '乐清' },
  AH: { Hefei: '合肥', Wuhu: '芜湖', Bengbu: '蚌埠', Huainan: '淮南', "Ma'anshan": '马鞍山', Maanshan: '马鞍山', Huaibei: '淮北', Tongling: '铜陵', Anqing: '安庆', Huangshan: '黄山', "Lu'an": '六安', Luan: '六安', Bozhou: '亳州', Chizhou: '池州', Xuancheng: '宣城' },
  FJ: { Fuzhou: '福州', Xiamen: '厦门', Putian: '莆田', Sanming: '三明', Quanzhou: '泉州', Zhangzhou: '漳州', Nanping: '南平', Longyan: '龙岩', Ningde: '宁德', Jinjiang: '晋江' },
  JX: { Nanchang: '南昌', Jingdezhen: '景德镇', Pingxiang: '萍乡', Jiujiang: '九江', Xinyu: '新余', Yingtan: '鹰潭', Ganzhou: '赣州', "Ji'an": '吉安', Jian: '吉安', Yichun: '宜春', Fuzhou: '抚州', Shangrao: '上饶' },
  SD: { Jinan: '济南', Qingdao: '青岛', Zibo: '淄博', Zaozhuang: '枣庄', Dongying: '东营', Yantai: '烟台', Weifang: '潍坊', Jining: '济宁', "Tai'an": '泰安', Taian: '泰安', Weihai: '威海', Rizhao: '日照', Linyi: '临沂', Dezhou: '德州', Liaocheng: '聊城', Binzhou: '滨州', Heze: '菏泽' },
  HA: { Zhengzhou: '郑州', Kaifeng: '开封', Luoyang: '洛阳', Pingdingshan: '平顶山', Anyang: '安阳', Hebi: '鹤壁', Xinxiang: '新乡', Jiaozuo: '焦作', Puyang: '濮阳', Xuchang: '许昌', Luohe: '漯河', Sanmenxia: '三门峡', Nanyang: '南阳', Shangqiu: '商丘', Xinyang: '信阳', Zhoukou: '周口', Zhumadian: '驻马店', Jiyuan: '济源' },
  HB: { Wuhan: '武汉', Huangshi: '黄石', Shiyan: '十堰', Yichang: '宜昌', Xiangyang: '襄阳', Xiangfan: '襄阳', Ezhou: '鄂州', Jingmen: '荆门', Xiaogan: '孝感', Jingzhou: '荆州', Huanggang: '黄冈', Xianning: '咸宁', Suizhou: '随州', Enshi: '恩施', Xiantao: '仙桃', Qianjiang: '潜江', Tianmen: '天门', Shennongjia: '神农架' },
  HN: { Changsha: '长沙', Zhuzhou: '株洲', Xiangtan: '湘潭', Hengyang: '衡阳', Shaoyang: '邵阳', Yueyang: '岳阳', Changde: '常德', Zhangjiajie: '张家界', Yiyang: '益阳', Chenzhou: '郴州', Yongzhou: '永州', Huaihua: '怀化', Loudi: '娄底', Xiangxi: '湘西' },
  GD: { Guangzhou: '广州', Shenzhen: '深圳', Zhuhai: '珠海', Shantou: '汕头', Foshan: '佛山', Shaoguan: '韶关', Zhanjiang: '湛江', Zhaoqing: '肇庆', Jiangmen: '江门', Maoming: '茂名', Huizhou: '惠州', Meizhou: '梅州', Shanwei: '汕尾', Heyuan: '河源', Yangjiang: '阳江', Qingyuan: '清远', Dongguan: '东莞', Zhongshan: '中山', Chaozhou: '潮州', Jieyang: '揭阳', Yunfu: '云浮' },
  GX: { Nanning: '南宁', Liuzhou: '柳州', Guilin: '桂林', Wuzhou: '梧州', Beihai: '北海', Fangchenggang: '防城港', Qinzhou: '钦州', Guigang: '贵港', Yulin: '玉林', Baise: '百色', Hezhou: '贺州', Hechi: '河池', Laibin: '来宾', Chongzuo: '崇左' },
  HI: { Haikou: '海口', Sanya: '三亚', Sansha: '三沙', Danzhou: '儋州', Wanning: '万宁', Wenchang: '文昌', Qionghai: '琼海', Lingshui: '陵水', Baoting: '保亭' },
  SC: { Chengdu: '成都', Zigong: '自贡', Panzhihua: '攀枝花', Luzhou: '泸州', Deyang: '德阳', Mianyang: '绵阳', Guangyuan: '广元', Suining: '遂宁', Neijiang: '内江', Leshan: '乐山', Nanchong: '南充', Meishan: '眉山', Yibin: '宜宾', "Guang'an": '广安', Guangan: '广安', Dazhou: '达州', "Ya'an": '雅安', Yaan: '雅安', Bazhong: '巴中', Ziyang: '资阳', Aba: '阿坝', Ganzi: '甘孜', Liangshan: '凉山' },
  GZ: { Guiyang: '贵阳', Liupanshui: '六盘水', Zunyi: '遵义', Anshun: '安顺', Bijie: '毕节', Tongren: '铜仁', Qiannan: '黔南', Qiandongnan: '黔东南', Qianxinan: '黔西南' },
  YN: { Kunming: '昆明', Qujing: '曲靖', Yuxi: '玉溪', Baoshan: '保山', Zhaotong: '昭通', Lijiang: '丽江', "Pu'er": '普洱', Puer: '普洱', Lincang: '临沧', Chuxiong: '楚雄', Honghe: '红河', Wenshan: '文山', Xishuangbanna: '西双版纳', Dali: '大理', Dehong: '德宏', Nujiang: '怒江', Diqing: '迪庆' },
  XZ: { Lhasa: '拉萨', Shigatse: '日喀则', Chamdo: '昌都', Nyingchi: '林芝', Shannan: '山南', Nagqu: '那曲', Ali: '阿里' },
  SN: { 'Xi\'an': '西安', Xian: '西安', Tongchuan: '铜川', Baoji: '宝鸡', Xianyang: '咸阳', Weinan: '渭南', 'Yan\'an': '延安', Yanan: '延安', Hanzhong: '汉中', Yulin: '榆林', Ankang: '安康', Shangluo: '商洛' },
  GS: { Lanzhou: '兰州', Jiayuguan: '嘉峪关', Jinchang: '金昌', Baiyin: '白银', Tianshui: '天水', Wuwei: '武威', Zhangye: '张掖', Pingliang: '平凉', Jiuquan: '酒泉', Qingyang: '庆阳', Dingxi: '定西', Longnan: '陇南', Linxia: '临夏', Gannan: '甘南' },
  QH: { Xining: '西宁', Haidong: '海东', Haibei: '海北', Huangnan: '黄南', Hainan: '海南州', Golog: '果洛', Yushu: '玉树', Haixi: '海西' },
  NX: { Yinchuan: '银川', Shizuishan: '石嘴山', Wuzhong: '吴忠', Guyuan: '固原', Zhongwei: '中卫' },
  XJ: { Urumqi: '乌鲁木齐', Karamay: '克拉玛依', Turpan: '吐鲁番', Hami: '哈密', Changji: '昌吉', Bortala: '博尔塔拉', Bayingolin: '巴音郭楞', Aksu: '阿克苏', Kizilsu: '克孜勒苏', Kashgar: '喀什', Hotan: '和田', Ili: '伊犁', Tacheng: '塔城', Altay: '阿勒泰', Shihezi: '石河子', Korla: '库尔勒', Kucha: '库车', Atushi: '阿图什', Kuqa: '库车' },
  HK: { 'Hong Kong': '香港', HongKong: '香港' },
  MO: { Macau: '澳门', Macao: '澳门' },
  TW: { Taipei: '台北', Kaohsiung: '高雄', Taichung: '台中', Tainan: '台南', 'New Taipei': '新北' },
};

function regionCn(cf) {
  const code = cf.regionCode || '';
  const country = cf.country || '';
  if (country && country !== 'CN') {
    return COUNTRIES[country] || country;
  }
  const prov = PROVINCES[code];
  if (!prov) return COUNTRIES[country] || '未知';
  const cityMap = CITIES[code] || {};
  const cityEn = (cf.city || '').trim();
  const city = cityMap[cityEn];
  if (city) return prov + city;
  // 拼音变体兜底：去掉空格/引号再试
  const cityAlt = cityEn.replace(/[\s'\-]/g, '').toLowerCase();
  for (const k in cityMap) {
    if (k.replace(/[\s'\-]/g, '').toLowerCase() === cityAlt && cityAlt) return prov + cityMap[k];
  }
  return prov;
}

// POST /api/track —— 访客记录（公开，sendBeacon 上报）
// body: { sid, ref, path?, slug? } —— slug 为作品集标识，用于按作品集统计与访问计数
export async function onRequestPost(context) {
  const { request, env } = context;

  let body = {};
  try {
    body = JSON.parse(await request.text());
  } catch {}

  const sid = String(body.sid || '').slice(0, 48);
  if (!sid) return json({ ok: true });

  // 作品集标识（限制长度与字符集）
  let slug = String(body.slug || '').slice(0, 40);
  if (slug && !/^[\w-]{1,40}$/.test(slug) && slug !== 'default') slug = '';

  // 频率限制：同一 IP 同一作品集 60 秒内只记录一次
  const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 45);
  const recent = await env.DB.prepare('SELECT ts FROM visits WHERE ip=? AND slug=? ORDER BY ts DESC LIMIT 1').bind(ip, slug).first();
  if (recent && Date.now() - recent.ts < 60 * 1000) return json({ ok: true });

  const ref = String(body.ref || '').slice(0, 250);
  const ua = (request.headers.get('User-Agent') || '').slice(0, 250);
  const cf = request.cf || {};
  const device = /iPad|Tablet/i.test(ua) ? '平板' : /Mobile|Android|iPhone/i.test(ua) ? '手机' : '电脑';
  const region = regionCn(cf);

  try {
    await env.DB.prepare(
      'INSERT INTO visits (ts, session, device, country, city, referrer, ua, ip, region_cn, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(Date.now(), sid, device, cf.country || '未知', cf.city || '', ref, ua, ip, region, slug)
      .run();

    // 作品集访问计数（访问限制依据）
    if (slug) {
      await env.DB.prepare('UPDATE portfolios SET views=views+1 WHERE slug=?').bind(slug).run();
    }
  } catch {}

  // 偶尔清理 90 天前的旧数据
  if (Math.random() < 0.02) {
    try {
      await env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(Date.now() - 90 * 86400 * 1000).run();
    } catch {}
  }

  return json({ ok: true });
}
