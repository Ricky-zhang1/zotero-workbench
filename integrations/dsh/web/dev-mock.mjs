/**
 * dev-server 的 mock 数据后端。
 *
 * 数据结构刻意对齐 host-backend-dev 确认的 Host half 响应形状：
 *   列表项：{ key, itemType, title, creators:{authors:[名], year}, date, dateAdded,
 *            dateModified, collectionKeys, tags, pdf:{key}|null, numChildren }
 *   详情：  { key, version, meta, data:{...Zotero item...}, attachments, notes,
 *            annotations, collectionNames, item:<同上> }
 * 这样前端在 mock 与真实宿主之间的行为一致。
 *
 * 注意：这是开发自测数据，不是真实 Zotero 文库；唯一使用真实 PDF 文件与
 * 真实公开论文元数据的是 3DWU883L（用于测试 PDF 渲染与中文文字层）。
 */

import { buildCitations } from './dev-export.mjs';

const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(now - offsetDays * day).toISOString();

const COLLECTIONS = [
  { key: 'MQV8FPQU', name: '教师政策研究', parentCollection: null, itemCount: 4 },
  { key: 'TCHBUDGT', name: '教师编制', parentCollection: 'MQV8FPQU', itemCount: 2 },
  { key: 'TCHFLOW', name: '教师流动', parentCollection: 'MQV8FPQU', itemCount: 2 },
  { key: 'METHD001', name: '研究方法', parentCollection: null, itemCount: 2 },
  { key: 'ENGLISH1', name: '英文文献', parentCollection: null, itemCount: 2 },
];

const SAVED_SEARCHES = [
  { key: 'SVTEACH1', name: '编外教师' },
  { key: 'SVTEACH2', name: '教师流动' },
];

/** Zotero item data 形状的 mock 条目（与真实 Zotero 字段保持一致）。 */
const MOCK_ITEMS = [
  {
    key: '3DWU883L',
    version: 25590,
    data: {
      key: '3DWU883L',
      itemType: 'journalArticle',
      title: '编外用师问题治理：结构矛盾与制度突破',
      date: '2022',
      language: 'zh-CN',
      publicationTitle: '教师教育研究',
      volume: '34',
      issue: '3',
      pages: '49-55',
      creators: [
        { creatorType: 'author', name: '李畇赟' },
        { creatorType: 'author', name: '刘善槐' },
      ],
      tags: [{ tag: '教师供给与编制' }],
      collections: ['MQV8FPQU', 'TCHBUDGT'],
      abstractNote:
        '在学龄人口剧烈变动的背景下，教师编制供需矛盾突出，公办中小学普遍面临教师短缺压力。本文分析编外用师制度的结构性矛盾，并提出制度突破路径。',
      dateAdded: iso(64),
      dateModified: iso(19),
    },
    attachments: [
      {
        key: '4GCTAFMJ',
        title: 'Full Text PDF',
        filename: '编外用师问题治理：结构矛盾与制度突破_李畇赟.pdf',
        contentType: 'application/pdf',
        isPdf: true,
      },
      {
        key: 'COVERPIC',
        title: '期刊封面',
        filename: 'cover.jpg',
        contentType: 'image/jpeg',
        isPdf: false,
      },
    ],
    notes: [
      {
        key: 'NOTE0001',
        dateModified: iso(12),
        html: '<p>阅读笔记：关注「同工不同酬」与「聘用标准错位」两条结构矛盾，可作为综述里的制度分析证据。</p>',
      },
    ],
    annotations: [
      {
        key: "C8YZTS2R",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "另一方面,编外教师的流动  性较大。调研发现,编外教师以中青年为主,他们 作为编 外 教 师 只 是 暂 时 的, 其 从 教 目 的 是 为 了 考  编,有其他好 的 就 业 岗 位 也 会 选 择 主 动 离 开",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[411.283,671.75,539.758,683.511],[308.038,655.157,539.757,665.082],[308.038,638.564,539.757,648.49],[308.038,621.971,518.215,631.896]],
        tags: [],
        dateAdded: "2026-08-25T10:08:54Z",
        sortIndex: "00004|000897|00158"
      },
      {
        key: "DQ22TLBU",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "一方面, 教 师 职 业 具 有 劳 动 对 象 复 杂 等 特 殊 性。教师职业的对象是具有主观能动性与个体差异 性的学生,他们正处于身心发育和品德意志等逐步  形成的关键时期。教学对象的复杂性对教师队伍的  稳定性提出了要求。",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[76.221,206.176,286.884,216.101],[55.261,190.068,286.884,199.994],[55.261,173.96,286.884,183.886],[55.261,157.852,286.884,167.778],[55.261,141.744,149.288,151.67]],
        tags: [],
        dateAdded: "2026-08-25T10:08:42Z",
        sortIndex: "00004|000708|00641"
      },
      {
        key: "S5CZCAG2",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "“市场化人力资源配置的流动性与中小学教师  岗位需求 的 稳 定 性 之 间 存 在 本 质 性 矛 盾。",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[73.795,270.607,286.872,280.533],[55.261,254.499,252.243,266.261]],
        tags: [],
        dateAdded: "2026-08-25T10:08:30Z",
        sortIndex: "00004|000604|00561"
      },
      {
        key: "6LR973NW",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "是编外教师  与在编教师的养老保险属于不同的类型,编外教师  难以享受与在编教师同等的养老保障,其退休后的  待遇也将远远少于在编教师。由于与在编教师的福  利待遇差距较大,编外教师往往难以安心从事教学 工作。",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[233.903,399.469,286.877,409.395],[55.261,383.362,286.877,393.287],[55.261,367.254,286.884,377.18],[55.261,351.146,286.884,361.072],[55.261,335.038,286.877,344.964],[55.261,318.93,86.507,328.856]],
        tags: [],
        dateAdded: "2026-08-25T10:08:19Z",
        sortIndex: "00004|000510|00464"
      },
      {
        key: "P3N569QB",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "二是编外教师的待遇结构较 为单一,难以享受到工资以外的福利待遇。由于编  外教师不属于体制内,难以在原有的工资之外享受  职业年金、房补等编制附带的福利。",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[157.051,447.793,286.878,458.069],[55.261,431.685,286.884,441.611],[55.261,415.577,286.884,425.503],[55.261,399.469,222.841,409.395]],
        tags: [],
        dateAdded: "2026-08-25T10:08:10Z",
        sortIndex: "00004|000422|00400"
      },
      {
        key: "DGSULCI8",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "是编外教师与在编教师的工资差距较大。",
        comment: "",
        color: "#5fb236",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[86.604,512.224,276.21,522.15]],
        tags: [],
        dateAdded: "2026-08-25T10:08:00Z",
        sortIndex: "00004|000310|00319"
      },
      {
        key: "QVQ8H23W",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "同工不同酬实践与同工同酬原则相背离  2018 年 8 月,国务院办公厅印发 《关于进一  步调整 优 化 结 构 提 高 教 育 经 费 使 用 效 益 的 意 见 》  ( 国办发 〔2018〕82 号) ,要求 “各地要严格规范 教师编制管理,对符合条件的非在编教师要加快入  编,并实行同 工 同 酬 ”。[14] 然 而, 调 查 发 现, 编 外  教师与在编教师同工不同酬现象仍十分普遍,主要  体现在三个方面。",
        comment: "",
        color: "#ffd400",
        pageLabel: "5",
        pageIndex: 4,
        rects: [[104.361,641.087,282.323,651.012],[75.639,624.979,286.884,634.905],[55.261,608.871,291.154,618.797],[55.261,592.763,286.884,602.689],[55.261,576.655,286.884,586.581],[55.261,560.548,286.884,572.309],[55.261,544.44,286.877,554.366],[55.261,528.332,138.906,538.258]],
        tags: [],
        dateAdded: "2026-08-25T10:07:53Z",
        sortIndex: "00004|000186|00223"
      },
      {
        key: "YCM6SE3U",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "三是聘用质量与实际需求不符。聘用 标准的第三个内涵是编外教师的资质标准,体现的  是岗位与能力相匹配的原则。相关政策大多对编外  — 52 编外用师问题治理: 结构矛盾与制度突破  教师的资质标准做了基本要求,但缺乏对教师专业  能力与师德素养等内在指标的规定。为了更容易招  到教师,有的学校甚至采取低进低聘的策略。",
        comment: "",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[371.887,123.017,539.757,132.942],[308.038,106.812,539.758,116.737],[308.038,90.704,539.758,100.63],[60.404,74.528,102.129,83.94]],
        tags: [],
        dateAdded: "2026-08-25T10:07:38Z",
        sortIndex: "00003|001265|00741"
      },
      {
        key: "GHVXJI9I",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "二是聘用结构与实际需求不符。聘用标准的第二个  内涵是需要什么学科的编外教师,关涉的是编外教 师结构的合理性。教育教学是一项分学科、分班级  进行的活动,师资配置在保障数量充足的同时,也  需要满足学科结构合理化的需求",
        comment: "这一点我们要考虑，跟以前可能有不同的是，现在这个缺教师更多是结构性缺师资，就因为这个选课走班造成的。然后再则是这个选课走班，它每年都会有变动，对于学科教师的那个需求每年也是有变动的，但是编制又定得很死",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[308.038,220.149,539.758,230.074],[308.038,203.944,539.758,213.87],[308.038,187.836,539.758,197.762],[308.038,171.631,539.757,181.557],[308.038,155.426,456.014,167.188]],
        tags: [],
        dateAdded: "2026-08-25T10:06:54Z",
        sortIndex: "00003|001086|00611"
      },
      {
        key: "RT3T3GSU",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "一是聘用数量与实际需求不符。聘用标准的第 一个内涵是不同学校需要多少编外教师,对此,地 方政府并未做出明确且符合实际需求的规定。调研 发现,G 省 曾 于 2008 年 提 出,因 教 师 脱 产 进 修、 长期病假、产假、支教等需要安排教师的中小学,  各市、县 ( 区) 教育行政部门按不超过学校在编  在岗教职员总数 5% 的原则提出临时聘请专任教师  的工作方案。至今,省内各级教育部门仍参考这一 指标控制编外教师数量,缺乏更具可操作性的测算  标准,致使编外教师数量往往难以满足实际需求。",
        comment: "",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[328.997,381.809,539.75,391.735],[308.038,365.701,539.757,375.627],[308.038,349.496,539.757,359.422],[308.038,333.389,544.997,343.314],[308.038,317.184,544.997,327.109],[308.038,300.979,539.758,310.905],[308.038,284.871,539.751,294.797],[308.038,268.666,539.75,278.592],[308.038,252.461,539.758,262.387],[308.038,236.354,544.997,246.279]],
        tags: [],
        dateAdded: "2026-08-25T10:06:40Z",
        sortIndex: "00003|000932|00498"
      },
      {
        key: "VQ9LK66P",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "三是学校自聘,学校通过公用经费自行聘任编  外教师并签订劳动合同。实际上,有的学校并没有  与编外教师签订正规劳动合同,有的学校仅与教师  达成口 头 协 定,因 而 这 是 随 意 性 最 大 的 一 种 形 式  ( 见图 3) 。由于大多数学校的生均公用经费有限, 这类编外教师的待遇较低,一般从几百到一千左右  不等。",
        comment: "",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[328.997,737.734,539.758,747.659],[308.038,722.014,539.758,731.94],[308.038,706.294,539.75,716.22],[308.038,690.575,539.757,700.5],[308.038,674.855,544.997,684.781],[308.038,659.135,539.75,669.061],[308.038,643.416,339.283,653.341]],
        tags: [],
        dateAdded: "2026-08-25T10:06:11Z",
        sortIndex: "00003|000627|00157"
      },
      {
        key: "KQD2NS3B",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "二是劳务派遣。劳务派遣是一种政府向第三方  购买教学服务的形式,即由教育局通过政府采购确  定第三方公司,由学校与第三方公司签订劳务派遣 合同,第三方公司与编外教师签订劳动合同,编外  教师向学校提供授课服务,其工资由第三方公司支  付 ( 见图 2) 。通过劳务派遣的编外教师属于劳务  公司员工,在法律关系上,对编外教师的一切管理 工作均由劳务派遣机构负责,学校只负责对派遣教  师的使用。",
        comment: "",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[76.221,412.084,286.884,422.01],[55.261,396.364,286.884,406.29],[55.261,380.645,286.877,390.57],[55.261,364.925,286.884,374.851],[55.261,349.205,286.884,359.131],[55.261,333.486,286.884,343.411],[55.261,317.766,286.884,327.692],[55.261,302.046,286.884,311.972],[55.261,286.327,107.466,296.252]],
        tags: [],
        dateAdded: "2026-08-25T10:06:01Z",
        sortIndex: "00003|000338|00419"
      },
      {
        key: "KF2VPTSG",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "一是政府直接购买服务。这是一种由教育局或 学校招聘,政府划拨专项资金到学校,学校与编外 教师签署劳动合同,编外教师向学校提供授课服务 的形式 ( 见图 1) 。该种形式下,学校与编外教师 有直接的人事关系,在岗期间要负责编外教师的各  种福利待遇等。政府直接购买服务一般有统一的经  费保障,从而可以较好地保障编外教师待遇。",
        comment: "",
        color: "#5fb236",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[76.221,594.316,286.884,604.242],[55.261,578.596,286.884,588.522],[55.261,562.876,286.877,572.802],[55.261,547.157,286.879,557.082],[55.261,531.437,286.884,541.363],[55.261,515.717,286.884,525.643],[55.261,499.998,264.663,509.923]],
        tags: [],
        dateAdded: "2026-08-25T10:05:51Z",
        sortIndex: "00003|000163|00237"
      },
      {
        key: "XQ2JB4DY",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "当前,全国尚没有形成  统一的编外用师规范,各地政府或学校根据自身情  况探索出多样化的类型。",
        comment: "",
        color: "#ffd400",
        pageLabel: "4",
        pageIndex: 3,
        rects: [[180.922,641.475,286.884,651.401],[55.261,625.755,286.884,635.681],[55.261,610.035,170.345,619.961]],
        tags: [],
        dateAdded: "2026-08-25T10:05:33Z",
        sortIndex: "00003|000120|00190"
      },
      {
        key: "65BNMNAB",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "因为在中央反复强调坚  决清退与禁止再聘编外教师的背景下,地方政府依 然聘用了大量以各种形式招聘、由财政或学校公用 经费负担薪酬却没有固定编制的教师,也就是说地  方政府的行为事实上已经偏离了中央政府的政策要  求,从而体现出地方政府在师资供给行为中的变通  特征。地方政府变通行为的产生与 “压力型体制” 有关,地方政府是在各种压力的驱动下运行的,上  级政府倾向于运用数量化的任务分解机制、各部门  共同参与的问题解决机制以及物质化的多层次评价  体系等 多 种 方 式 要 求 下 级 政 府 完 成 各 项 政 绩 指 标",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[433.786,400.052,539.758,409.977],[308.038,383.168,539.758,393.093],[308.038,366.283,539.758,376.209],[308.038,349.399,539.758,359.325],[308.038,332.515,539.758,341.927],[308.038,315.534,539.758,325.46],[308.038,298.553,544.027,308.479],[308.038,281.572,539.757,291.498],[308.038,264.591,539.758,274.516],[308.038,247.61,539.75,257.021],[308.038,230.628,539.758,240.04],[308.038,213.647,318.323,225.409]],
        tags: [],
        dateAdded: "2026-08-25T10:02:56Z",
        sortIndex: "00002|001387|00533"
      },
      {
        key: "LGA3P3RY",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "制度变通是 “在制度的运作中,执行者在未得  到制度决定者的正式准许、未通过改变制度的正式 程序的情况下,自行做出改变原制度中的某些部分  的决策,从而推行一套经过改变的制度安排这样一  种行为或运 作 方 式 ”",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[328.997,501.356,539.758,511.282],[308.038,484.472,539.758,494.398],[308.038,467.588,539.758,477.514],[308.038,450.704,539.758,460.63],[308.038,433.82,403.908,445.581]],
        tags: [],
        dateAdded: "2026-08-25T10:02:42Z",
        sortIndex: "00002|001142|00347"
      },
      {
        key: "N2VWJWJQ",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "纵览义务教育发展历程,每当学校师资短缺  时,几乎都会出现有关编外用师的实践探索。作为  一种特殊的师资供给方式,编外用师在一定程度上  缓解了教育发展对师资数量的强烈需求与师资供给  不足之间的矛盾,于是制度的制定者对该路径的依  赖性与适应性逐渐增强。正是由于政府在长期实践  中摸索出的应对方式发挥了有效的功用,才会对旧 有制度产生路径依赖,从而实现编外用师治理体系 的延续与再生产。",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[337.828,687.081,539.758,698.843],[308.038,670.197,539.75,680.123],[308.038,653.313,539.758,663.239],[308.038,636.429,539.758,645.84],[308.038,619.545,539.758,629.471],[308.038,602.661,539.75,612.587],[308.038,585.777,539.758,595.702],[308.038,568.893,539.758,578.818],[308.038,552.009,391.682,561.934]],
        tags: [],
        dateAdded: "2026-08-25T10:02:32Z",
        sortIndex: "00002|000959|00178"
      },
      {
        key: "7WM9EI8K",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "民办  教师不允许出现的政策制约使得农村教师的补充缺  乏稳定的供给来源,取而代之的是代课教师作为一  种多元结构临时性师资出现在广大偏远贫困农村地  区。[10]",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[265.73,127.965,286.884,137.891],[308.038,737.734,539.661,747.145],[308.038,720.85,539.63,730.775],[308.038,703.965,539.758,713.377],[308.038,687.081,337.827,698.843]],
        tags: [],
        dateAdded: "2026-08-25T10:02:22Z",
        sortIndex: "00002|000890|00128"
      },
      {
        key: "43932HB4",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "诺斯 ( Douglass C. North) 将路径依赖性概括  为 “小的事件和偶然情形的结果可能使解决方案一  旦处于优 势 就 会 导 致 一 个 特 定 的 路 线 ”。",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[76.221,224.612,286.884,234.538],[55.261,208.504,286.884,218.43],[55.261,192.397,247.294,204.158]],
        tags: [],
        dateAdded: "2026-08-25T10:01:55Z",
        sortIndex: "00002|000684|00607"
      },
      {
        key: "2WAHMYUB",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "在编制核定主导的师资配置制度背景下,“师 资需 求 增 加” 与 “教 师 编 制 短 缺 ” 的 矛 盾 使 得  “编外用师” 成为必然性的政策选择,而相应的编  外用师治理体制正是地方政府对编制制度多重缺陷  的有效弥补。编外用师所具有的临时性、短期性、  灵活性等特征有利于突破编制 “只减不增” 的制  度约束,也有利于克服编制核定的滞后性以及编制  “铁饭碗” 属性等局限。",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[76.221,385.69,286.884,395.616],[55.261,369.583,286.884,379.508],[52.836,353.475,286.884,363.401],[55.261,337.367,286.884,346.778],[55.261,321.259,292.124,331.185],[55.261,305.151,286.884,315.077],[55.261,289.044,286.884,298.969],[52.836,272.936,167.046,282.861]],
        tags: [],
        dateAdded: "2026-08-25T10:01:46Z",
        sortIndex: "00002|000587|00510"
      },
      {
        key: "PUMQVTJU",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "教师培训也会产生部分临时 性教师需求,然而,编制的 “铁饭碗” 特性使其难  以具备灵活应对临时性师资需求的功能。",
        comment: "教师生育、病休、培训会产生临时性教师需求",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[158.022,434.014,287.163,444.29],[55.261,417.906,287.168,427.832],[55.261,401.798,238.755,411.724]],
        tags: [],
        dateAdded: "2026-08-25T10:01:14Z",
        sortIndex: "00002|000463|00413"
      },
      {
        key: "SQFBZAZB",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "第三,编制的 “铁  饭碗” 特性使其难以应对临时性师资需求的增加。  教师产 假、培 训 等 情 况 都 可 能 使 教 师 出 现 短 期 缺  口,这几种情况如果频繁发生,就会产生大量临时  性教师需求。",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[198.485,578.984,286.884,588.91],[55.261,562.876,292.124,572.802],[55.261,546.769,286.884,556.694],[55.261,530.661,286.869,540.587],[55.261,514.553,117.946,524.479]],
        tags: [],
        dateAdded: "2026-08-25T10:00:58Z",
        sortIndex: "00002|000263|00268"
      },
      {
        key: "2F8RRNYC",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "地方政府职能转变和机构改革  工作电视电话会议提出 “确保财政供养人员只减不  增”。[8]这一制度限制使得教师编制难以充足供给,  从而推动地方政府重启编外用师治理体制。第二,  编制核定的滞后性使得快速增加的师资需求得不到  及时满足。学校教育教学秩序的正常开展要求编制  核定必须在新学年之前完成。然而,现实中编制核  定总是相对滞后,核编调整周期与学生人数变化周  期存在时间差,导致学生人数增加较快的县 ( 市、  区) 教师缺口不能及时补足。",
        comment: "",
        color: "#ffd400",
        pageLabel: "3",
        pageIndex: 2,
        rects: [[146.377,722.014,286.884,731.94],[55.261,706.294,286.884,716.22],[55.261,690.575,292.124,702.336],[55.261,674.855,292.124,684.781],[55.261,659.135,286.869,668.547],[55.261,643.416,286.884,653.341],[55.261,627.308,286.884,637.233],[55.261,611.2,286.884,621.126],[55.261,595.092,292.124,605.018],[55.261,578.984,197.806,588.91]],
        tags: [],
        dateAdded: "2026-08-25T10:00:52Z",
        sortIndex: "00002|000085|00139"
      },
      {
        key: "IMFX59JV",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "制度环境是编外用师得以延续的基础性逻辑。  任何组织都是在一定的制度环境中生存,特定的制  度安排会影 响 组 织 的 结 构 与 行 为。",
        comment: "",
        color: "#ffd400",
        pageLabel: "2",
        pageIndex: 1,
        rects: [[328.997,416.257,544.997,426.182],[308.038,400.052,539.758,409.977],[308.038,383.847,468.534,395.608]],
        tags: [],
        dateAdded: "2026-08-25T10:00:34Z",
        sortIndex: "00001|001178|00415"
      },
      {
        key: "4BWILY2A",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "近 几 年, 学 龄  人口剧烈变动,师资需求不断变化,编制供需矛盾  凸显了当前编制制度的诸多局限。正是由于教师编  制制度在有效应对师资需求变化方面存在不足,促  使各地普遍聘用编外教师。第一,师资需求总量增  加而编制 “只减不增”。在城镇化步伐加快、户籍  制度改 革 等 因 素 的 影 响 下,乡 村 人 口 大 量 涌 入 城  镇,城乡学龄人口的数量与分布剧烈变动,使得教  师总体需求增加。",
        comment: "",
        color: "#ffd400",
        pageLabel: "2",
        pageIndex: 1,
        rects: [[475.229,383.847,539.757,395.608],[308.038,367.642,539.75,377.568],[308.038,351.437,539.758,361.363],[308.038,335.232,539.757,345.158],[308.038,319.027,539.758,328.953],[308.038,302.823,539.757,312.748],[308.038,286.618,539.757,296.543],[308.038,270.413,539.758,280.339],[308.038,254.208,391.682,264.134]],
        tags: [],
        dateAdded: "2026-08-25T10:00:27Z",
        sortIndex: "00001|001266|00480"
      },
      {
        key: "KYTWRSUR",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "根据当前各地的编外用师实践,本研究将编外  教师界定为: 因正式教师短缺而在公办中小学承担 一定教学任务,但没有事业编制的临时教师,主要  包括代课教师与临聘教师。",
        comment: "",
        color: "#ffd400",
        pageLabel: "2",
        pageIndex: 1,
        rects: [[328.9,705.518,539.661,715.444],[308.038,689.41,539.758,699.336],[308.038,673.302,539.75,683.228],[308.038,657.195,433.601,667.12]],
        tags: [],
        dateAdded: "2026-08-25T09:59:49Z",
        sortIndex: "00001|000889|00142"
      },
      {
        key: "H36A69GW",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "从 体 制 外 扩 充 教 师  数量的模式创新性地突破了教师编制数量限制,但  需要较强的财力保证,且存在 ‘公平隐患’。”[4]针  对编外用师衍生的诸多问题,学术界也提出了许多  优化建议。如 “规范代课教师管理制度” “建立代  课教师人才备用库” 以及合理清退不合格代课教师  等,[5]然而至今仍 未 形 成 妥 善 的 解 决 方 式 和 成 熟 的 管理机制。[6] “代课教师是基础教育均衡发展不可 缺少的组成部分,在一个运行良好的教育系统中,  代课教 师 的 聘 用 是 客 观 必 然 的",
        comment: "",
        color: "#ffd400",
        pageLabel: "2",
        pageIndex: 1,
        rects: [[198.485,360.461,286.875,372.223],[55.261,344.742,286.884,354.667],[55.261,329.022,286.884,340.784],[55.261,313.302,286.884,323.228],[55.261,297.583,286.884,307.508],[55.261,281.863,286.877,291.789],[55.261,266.143,286.884,277.905],[55.261,250.424,286.878,262.185],[55.261,234.704,292.124,244.63],[55.261,218.984,198,230.746]],
        tags: [],
        dateAdded: "2026-08-25T09:59:25Z",
        sortIndex: "00001|000686|00597"
      },
      {
        key: "N3Z2JVFD",
        parentAttachment: "4GCTAFMJ",
        type: "highlight",
        text: "事实上,我国编外用师的现象一直存在,在教  育资源匮乏的特殊年代出现的民办教师与代课教师  是较早的编外教师。近几年,面对教育发展需求与  编制紧缺的矛盾,各地探索出了多样化的编外用师  类型。然而,由于编外教师与在编教师的身份属性  不同,因此在学校内部形成了教师资源的 “二元结 构”,增加了教师管理的复杂性。有学者提出,编  外用师改革存在教师劳动合同的法律风险、教师身  份地位的双轨风险以及编外用师改革的持续风险等  三重风险。",
        comment: "",
        color: "#ffd400",
        pageLabel: "2",
        pageIndex: 1,
        rects: [[76.221,501.938,286.884,511.864],[55.261,486.219,286.877,495.63],[55.261,470.499,286.884,480.425],[55.261,454.779,286.877,464.705],[55.261,439.06,286.884,448.985],[55.261,423.34,286.884,433.266],[55.261,407.62,286.884,417.546],[55.261,391.901,286.869,401.826],[55.261,376.181,286.884,385.592],[55.261,360.461,107.66,372.223]],
        tags: [],
        dateAdded: "2026-08-25T09:59:07Z",
        sortIndex: "00001|000305|00329"
      }
    ],
  },
  {
    key: 'QZ7FE8SD',
    version: 12001,
    data: {
      key: 'QZ7FE8SD',
      itemType: 'journalArticle',
      title:
        'Perceived Obstacles to University–Industry Collaboration: Results from a Qualitative Survey of Italian Academic Departments',
      date: '2014',
      language: 'en',
      publicationTitle: 'Industry and Innovation',
      volume: '21',
      issue: '5',
      pages: '418-439',
      DOI: '10.1080/13662716.2014.969935',
      creators: [
        { creatorType: 'author', firstName: 'Alessandro', lastName: 'Muscio' },
        { creatorType: 'author', firstName: 'Giovanna', lastName: 'Vallanti' },
      ],
      tags: [{ tag: 'university-industry' }, { tag: 'qualitative' }],
      collections: ['METHD001'],
      abstractNote: 'A qualitative survey of Italian academic departments on the obstacles to university–industry collaboration.',
      dateAdded: iso(120),
      dateModified: iso(88),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'K7M2NPQX',
    version: 12002,
    data: {
      key: 'K7M2NPQX',
      itemType: 'journalArticle',
      title: '县域普通高中振兴政策注意力的结构及其调整——基于 26 份省级《县中计划》文本分析',
      date: '2024',
      language: 'zh-CN',
      publicationTitle: '教育研究',
      issue: '8',
      pages: '35-46',
      creators: [{ creatorType: 'author', name: '向秒' }],
      tags: [{ tag: '县中计划' }, { tag: '政策注意力' }],
      collections: ['MQV8FPQU'],
      abstractNote: '以 26 份省级《县中计划》为语料，分析地方政府政策注意力的结构与调整逻辑。',
      dateAdded: iso(52),
      dateModified: iso(31),
    },
    attachments: [
      {
        key: 'M2PDF7QK',
        title: 'Full Text PDF (mock second)',
        filename: 'mock-second-pdf.pdf',
        contentType: 'application/pdf',
        isPdf: true,
      },
    ],
    notes: [],
    annotations: [],
  },
  {
    key: 'BJRCVBJU',
    version: 12003,
    data: {
      key: 'BJRCVBJU',
      itemType: 'journalArticle',
      title: 'Easy in, Easy out: Are Alternatively Certified Teachers Turning Over at Increased Rates?',
      date: '2016',
      language: 'en',
      publicationTitle: 'American Educational Research Journal',
      volume: '53',
      issue: '4',
      pages: '1086-1125',
      DOI: '10.3102/0002831216653206',
      creators: [
        { creatorType: 'author', firstName: 'Christopher', lastName: 'Redding' },
        { creatorType: 'author', firstName: 'Thomas M.', lastName: 'Smith' },
      ],
      tags: [{ tag: 'teacher turnover' }, { tag: 'alternative certification' }],
      collections: ['MQV8FPQU', 'TCHFLOW'],
      abstractNote: 'Compares turnover rates of alternatively certified teachers with traditionally certified peers.',
      dateAdded: iso(97),
      dateModified: iso(75),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'CTGJ2Y8S',
    version: 12004,
    data: {
      key: 'CTGJ2Y8S',
      itemType: 'journalArticle',
      title:
        'Smart specialization policy in the European Union: Relatedness, knowledge complexity and regional diversification',
      date: '2019',
      language: 'en',
      publicationTitle: 'Regional Studies',
      volume: '53',
      issue: '9',
      pages: '1252-1268',
      DOI: '10.1080/00343404.2018.1437900',
      creators: [
        { creatorType: 'author', firstName: 'Pierre-Alexandre', lastName: 'Balland' },
        { creatorType: 'author', firstName: 'Ron', lastName: 'Boschma' },
        { creatorType: 'author', firstName: 'Joan', lastName: 'Crespo' },
      ],
      tags: [{ tag: 'smart specialization' }, { tag: 'relatedness' }],
      collections: ['METHD001'],
      abstractNote: 'Examines the relationship between relatedness, knowledge complexity and regional diversification in EU smart specialization policy.',
      dateAdded: iso(140),
      dateModified: iso(102),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'W9HK3TRD',
    version: 12005,
    data: {
      key: 'W9HK3TRD',
      itemType: 'journalArticle',
      title: '教师编制供需矛盾下的编外用工治理——基于东部三省的调研',
      date: '2023',
      language: 'zh-CN',
      publicationTitle: '教育发展研究',
      issue: '12',
      pages: '18-27',
      creators: [
        { creatorType: 'author', name: '王玉婷' },
        { creatorType: 'author', name: '陈国安' },
      ],
      tags: [{ tag: '编外用师' }, { tag: '教师编制' }],
      collections: ['TCHBUDGT'],
      abstractNote: '基于东部三省调研，分析教师编制供需矛盾下编外用工的治理困境。',
      dateAdded: iso(58),
      dateModified: iso(22),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'Y5N8QWZR',
    version: 12006,
    data: {
      key: 'Y5N8QWZR',
      itemType: 'journalArticle',
      title: '教育社会学视角下的教师职业稳定性研究——以县域公办学校为例',
      date: '2021',
      language: 'zh-CN',
      publicationTitle: '社会',
      volume: '41',
      issue: '3',
      pages: '88-112',
      creators: [{ creatorType: 'author', name: '周雪' }],
      tags: [{ tag: '教师职业' }, { tag: '县域' }],
      collections: ['TCHFLOW'],
      abstractNote: '从教育社会学视角讨论县域公办学校教师的职业稳定性与社会流动。',
      dateAdded: iso(110),
      dateModified: iso(64),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'P2X6CVBN',
    version: 12007,
    data: {
      key: 'P2X6CVBN',
      itemType: 'journalArticle',
      title: 'Teacher Recruitment and Retention in Rural Schools: A Systematic Review of the Evidence',
      date: '2020',
      language: 'en',
      publicationTitle: 'Review of Educational Research',
      volume: '90',
      issue: '2',
      pages: '185-226',
      DOI: '10.3102/0034654319899660',
      creators: [
        { creatorType: 'author', firstName: 'Beng Huat', lastName: 'See' },
        { creatorType: 'author', firstName: 'Stephen', lastName: 'Gorard' },
      ],
      tags: [{ tag: 'rural schools' }, { tag: 'recruitment' }],
      collections: ['ENGLISH1'],
      abstractNote: 'Systematic review of international evidence on teacher recruitment and retention in rural schools.',
      dateAdded: iso(150),
      dateModified: iso(121),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'R8T3YHWN',
    version: 12008,
    data: {
      key: 'R8T3YHWN',
      itemType: 'conferencePaper',
      title: '教师流动政策的地方执行偏差：基于政策文本与访谈的比较',
      date: '2020',
      publicationTitle: '中国教育学会教育政策专业委员会年会',
      creators: [{ creatorType: 'author', name: '林嘉' }],
      tags: [{ tag: '教师流动' }, { tag: '政策执行' }],
      collections: [],
      abstractNote: '比较政策文本与地方执行实践，分析教师流动政策的执行偏差。',
      dateAdded: iso(86),
      dateModified: iso(72),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'C5V7BQJX',
    version: 12009,
    data: {
      key: 'C5V7BQJX',
      itemType: 'journalArticle',
      title: '乡村教师支持计划的实施效果评估——基于中西部六省的面板数据',
      date: '2019',
      language: 'zh-CN',
      publicationTitle: '教育经济评论',
      issue: '6',
      pages: '3-21',
      creators: [
        { creatorType: 'author', name: '赵明远' },
        { creatorType: 'author', name: '孙晓' },
      ],
      tags: [{ tag: '乡村教师' }, { tag: '政策评估' }],
      collections: ['MQV8FPQU'],
      abstractNote: '使用中西部六省面板数据评估乡村教师支持计划的实施效果。',
      dateAdded: iso(130),
      dateModified: iso(96),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'Z6K2WDQF',
    version: 12010,
    data: {
      key: 'Z6K2WDQF',
      itemType: 'journalArticle',
      title: 'The Impact of Performance Pay on Teacher Retention: Evidence from a Field Experiment',
      date: '2018',
      language: 'en',
      publicationTitle: 'Journal of Human Resources',
      volume: '53',
      issue: '3',
      pages: '635-671',
      DOI: '10.3368/jhr.53.3.0115-6899R1',
      creators: [
        { creatorType: 'author', firstName: 'Matthew', lastName: 'Springer' },
        { creatorType: 'author', firstName: 'James', lastName: 'Popham' },
      ],
      tags: [{ tag: 'performance pay' }, { tag: 'teacher retention' }],
      collections: ['ENGLISH1'],
      abstractNote: 'Field-experimental evidence on the effect of performance pay on teacher retention.',
      dateAdded: iso(160),
      dateModified: iso(140),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
  {
    key: 'F3N9LMXT',
    version: 12011,
    data: {
      key: 'F3N9LMXT',
      itemType: 'journalArticle',
      title: '教师专业伦理问责的制度逻辑：价值、困境与破解',
      date: '2024',
      language: 'zh-CN',
      publicationTitle: '全球教育展望',
      issue: '2',
      pages: '55-68',
      creators: [{ creatorType: 'author', name: '何静' }],
      tags: [{ tag: '教师伦理' }, { tag: '问责' }],
      collections: [],
      abstractNote: '讨论教师专业伦理问责制度的价值基础与现实困境。',
      dateAdded: iso(44),
      dateModified: iso(30),
    },
    attachments: [],
    notes: [],
    annotations: [],
  },
];

const ITEMS_BY_KEY = new Map(MOCK_ITEMS.map((item) => [item.key, item]));

/** 角标定位 mock：用 3DWU883L 的真实批注 rects 构造同文献 2 处引文。 */
function buildMockCitationRecords() {
  const item = ITEMS_BY_KEY.get('3DWU883L');
  if (!item) return [];
  const data = item.data;
  const authors = creatorNames(data.creators).join('、');
  const candidates = (item.annotations || []).filter((annotation) => Array.isArray(annotation.rects) && annotation.rects.length);
  const picks = [];
  const seenPages = new Set();
  for (const annotation of candidates) {
    if (seenPages.has(annotation.pageIndex)) continue;
    seenPages.add(annotation.pageIndex);
    picks.push(annotation);
    if (picks.length === 2) break;
  }
  const ids = ['a1b2c3d4e5f6', 'f6e5d4c3b2a1'];
  return picks.map((annotation, index) => ({
    id: ids[index] || `c1d2e3f4a5b${index}`,
    itemKey: item.key,
    attachmentKey: annotation.parentAttachment || '4GCTAFMJ',
    pageIndex: annotation.pageIndex,
    pageLabel: annotation.pageLabel || String(annotation.pageIndex + 1),
    quote: annotation.text,
    rects: annotation.rects,
    title: data.title,
    authors,
    year: String(data.date || '').slice(0, 4),
    venue: data.publicationTitle || '',
    doi: data.DOI || '',
    verifiedAt: '2026-10-28T12:00:00.000Z',
    zoteroItemUrl: `zotero://select/library/items/${item.key}`,
    zoteroPdfUrl: `zotero://open-pdf/library/items/${annotation.parentAttachment || '4GCTAFMJ'}?page=${annotation.pageIndex + 1}`,
  }));
}

const CITATION_RECORDS = buildMockCitationRecords();
const COLLECTION_BY_KEY = new Map(COLLECTIONS.map((collection) => [collection.key, collection]));

function collectionDepth(key) {
  let depth = 0;
  let cursor = COLLECTION_BY_KEY.get(key);
  const seen = new Set();
  while (cursor && cursor.parentCollection && !seen.has(cursor.key)) {
    seen.add(cursor.key);
    cursor = COLLECTION_BY_KEY.get(cursor.parentCollection);
    if (cursor) depth += 1;
    else break;
  }
  return depth;
}

function collectionNameMap() {
  const map = {};
  for (const collection of COLLECTIONS) map[collection.key] = collection.name;
  return map;
}

function creatorNames(creators) {
  return (creators || [])
    .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' '))
    .filter(Boolean);
}

function toListPdf(item) {
  const attachment = (item.attachments || []).find((entry) => entry.isPdf);
  return attachment ? { key: attachment.key } : null;
}

function toSummary(item) {
  const data = item.data;
  const date = String(data.date || '');
  const yearMatch = date.match(/\d{4}/);
  return {
    key: item.key,
    version: item.version,
    itemType: data.itemType,
    title: data.title,
    creators: {
      authors: creatorNames(data.creators),
      year: yearMatch ? yearMatch[0] : '',
    },
    date,
    dateAdded: data.dateAdded,
    dateModified: data.dateModified,
    collectionKeys: data.collections || [],
    tags: (data.tags || []).map((tag) => tag.tag).filter(Boolean),
    pdf: toListPdf(item),
    hasPdf: Boolean(toListPdf(item)),
    numChildren: (item.attachments || []).length + (item.notes || []).length,
  };
}

function descendantCollectionKeys(key) {
  const keys = new Set([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of COLLECTIONS) {
      if (collection.parentCollection && keys.has(collection.parentCollection) && !keys.has(collection.key)) {
        keys.add(collection.key);
        changed = true;
      }
    }
  }
  return keys;
}

function compareItems(sort, direction) {
  const factor = direction === 'asc' ? 1 : -1;
  const field = sort || 'dateModified';
  return (left, right) => {
    const a = left.data;
    const b = right.data;
    switch (field) {
      case 'title':
        return factor * String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
      case 'creator': {
        const an = creatorNames(a.creators)[0] || '';
        const bn = creatorNames(b.creators)[0] || '';
        return factor * String(an).localeCompare(String(bn), 'zh-Hans-CN');
      }
      case 'year':
      case 'date': {
        const ay = Number(String(a.date || '').match(/\d{4}/)?.[0] || 0);
        const by = Number(String(b.date || '').match(/\d{4}/)?.[0] || 0);
        return factor * (ay - by);
      }
      case 'dateAdded':
        return factor * String(a.dateAdded || '').localeCompare(String(b.dateAdded || ''));
      case 'itemType':
        return factor * String(a.itemType || '').localeCompare(String(b.itemType || ''));
      case 'dateModified':
      default:
        return factor * String(a.dateModified || '').localeCompare(String(b.dateModified || ''));
    }
  };
}

function defaultDirection(sort) {
  return sort === 'title' || sort === 'creator' ? 'asc' : 'desc';
}

/**
 * @param {{pageCap?:number, pdfPath?:string, fail?:boolean}} options
 */
export function createMockBackend({ pageCap = 8, pdfPath = '', fail = false } = {}) {
  const collectionNames = collectionNameMap();
  const pageCapValue = Math.max(1, Math.min(100, Number(pageCap) || 8));

  function ensureOk() {
    if (fail) {
      const error = new Error('Mock：模拟宿主 API 故障（MOCK_API_FAIL=1）');
      error.status = 503;
      error.code = 'backend_unavailable';
      throw error;
    }
  }

  return {
    mode: 'mock',

    async health() {
      return {
        ok: true,
        version: '0.10.0-mock',
        mode: 'mock',
        zotero: { reachable: true, version: 'mock-7.0' },
        // 与 Host 契约一致：Zotero < 10 时不允许前端写阅读高亮。
        writes: { annotations: false, reason: 'requires-zotero-10' },
      };
    },

    async collections(library) {
      ensureOk();
      return {
        library: library || 'user',
        libraries: [{ id: 'user', type: 'user', name: '我的文库（mock）' }],
        collections: COLLECTIONS.map((collection) => ({
          key: collection.key,
          name: collection.name,
          parentCollection: collection.parentCollection,
          itemCount: collection.itemCount,
          depth: collectionDepth(collection.key),
          meta: { numItems: collection.itemCount },
        })),
        savedSearches: SAVED_SEARCHES,
      };
    },

    async items({ q = '', collection = '', sort = 'dateModified', direction = '', start = 0, limit = 25, tag = '' } = {}) {
      ensureOk();
      const query = String(q || '').trim().toLowerCase();
      const collectionKeys = collection ? descendantCollectionKeys(collection) : null;
      const tagFilter = String(tag || '').trim().toLowerCase();
      let list = MOCK_ITEMS.filter((item) => {
        const data = item.data;
        if (collectionKeys && !(data.collections || []).some((key) => collectionKeys.has(key))) return false;
        if (tagFilter && !(data.tags || []).some((entry) => String(entry.tag || '').toLowerCase() === tagFilter)) return false;
        if (!query) return true;
        const haystack = [
          data.title,
          creatorNames(data.creators).join(' '),
          (data.tags || []).map((entry) => entry.tag).join(' '),
          data.abstractNote,
          data.publicationTitle,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });

      const sortField = sort || 'dateModified';
      const dir = direction || defaultDirection(sortField);
      list = list.sort(compareItems(sortField, dir));

      const total = list.length;
      const startIndex = Math.max(0, Number(start) || 0);
      const requestedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
      // 故意把单页上限压到 pageCap，用于验证「加载更多」分页。
      const effectiveLimit = Math.min(requestedLimit, pageCapValue);
      const page = list.slice(startIndex, startIndex + effectiveLimit);
      const nextStart = startIndex + page.length < total ? startIndex + page.length : null;
      return {
        library: 'user',
        items: page.map(toSummary),
        nextStart,
        total,
        start: startIndex,
        limit: effectiveLimit,
        sort: sortField,
        direction: dir,
      };
    },

    async item({ key } = {}) {
      ensureOk();
      const item = ITEMS_BY_KEY.get(String(key || ''));
      if (!item) {
        const error = new Error(`Mock：找不到条目 ${key}`);
        error.status = 404;
        error.code = 'item_not_found';
        throw error;
      }
      const data = item.data;
      const meta = {
        creatorSummary: creatorNames(data.creators).join(' 和 '),
        parsedDate: data.date || '',
        numChildren: (item.attachments || []).length + (item.notes || []).length,
      };
      const itemJson = { key: item.key, version: item.version, meta, data };
      const payload = {
        key: item.key,
        version: item.version,
        meta,
        data,
        attachments: (item.attachments || []).map((attachment) => ({ ...attachment })),
        notes: (item.notes || []).map((note) => ({ ...note })),
        annotations: (item.annotations || []).map((annotation) => ({
          ...annotation,
          tags: annotation.tags || [],
        })),
        collectionNames,
        // 与真实 Host half 一致：item 别名指向原始 Zotero item JSON（不循环引用）
        item: itemJson,
      };
      return payload;
    },

    async pdf({ key } = {}) {
      ensureOk();
      const requested = String(key || '');
      const item = ITEMS_BY_KEY.get(requested);
      if (!item) {
        for (const candidate of MOCK_ITEMS) {
          const attachment = (candidate.attachments || []).find((entry) => entry.key === requested && entry.isPdf);
          if (attachment) return { filePath: pdfPath, attachmentKey: attachment.key };
        }
        const error = new Error(`Mock：条目 ${key} 没有 PDF 附件`);
        error.status = 404;
        error.code = 'pdf_not_found';
        throw error;
      }
      const attachment = (item.attachments || []).find((entry) => entry.isPdf);
      if (!attachment) {
        const error = new Error(`Mock：条目 ${key} 没有 PDF 附件`);
        error.status = 404;
        error.code = 'pdf_not_found';
        throw error;
      }
      return { filePath: pdfPath, attachmentKey: attachment.key };
    },

    async citations({ keys = [], format = 'bibtex', style = 'apa', locale = 'zh-CN' } = {}) {
      ensureOk();
      const list = String(keys || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      if (!list.length) {
        const error = new Error('缺少 keys 参数');
        error.status = 400;
        error.code = 'bad_request';
        throw error;
      }
      if (list.length > 200) {
        const error = new Error('keys 最多 200 个');
        error.status = 400;
        error.code = 'too_many_keys';
        throw error;
      }
      const selected = list.map((key) => ITEMS_BY_KEY.get(key)).filter(Boolean);
      const missing = list.filter((key) => !ITEMS_BY_KEY.has(key));
      if (!selected.length) {
        const error = new Error('找不到任何匹配的条目');
        error.status = 404;
        error.code = 'items_not_found';
        throw error;
      }
      const result = buildCitations(selected, { format, style, locale });
      return { ...result, missing };
    },

    async maintenance({ view = 'unfiled', offset = 0, limit = 50 } = {}) {
      ensureOk();
      const validViews = new Set(['unfiled', 'missingDOI', 'missingPDF']);
      if (!validViews.has(view)) {
        const error = new Error(`未知视图：${view}`);
        error.status = 400;
        error.code = 'bad_request';
        throw error;
      }
      const start = Math.max(0, Number(offset) || 0);
      const size = Math.max(1, Math.min(100, Number(limit) || 50));
      const candidates = MOCK_ITEMS.map((item) => {
        const summary = toSummary(item);
        return {
          ...summary,
          hasPdf: Boolean(toListPdf(item)),
          hasDOI: Boolean(item.data.DOI),
          collectionsCount: (item.data.collections || []).length,
        };
      }).filter((entry) => {
        if (view === 'unfiled') return entry.collectionsCount === 0;
        if (view === 'missingDOI') return !entry.hasDOI;
        return !entry.hasPdf;
      });
      return {
        view,
        total: candidates.length,
        offset: start,
        limit: size,
        truncated: false,
        cachedAt: new Date().toISOString(),
        items: candidates.slice(start, start + size).map((entry) => ({
          key: entry.key,
          title: entry.title,
          creators: entry.creators,
          itemType: entry.itemType,
          hasPdf: entry.hasPdf,
          hasDOI: entry.hasDOI,
          collectionsCount: entry.collectionsCount,
        })),
      };
    },

    async open({ kind = 'item', key = '', attachmentKey = '', page = 0, annotationKey = '' } = {}) {
      ensureOk();
      const keyPattern = /^[A-Z0-9]{8}$/;
      if (!keyPattern.test(String(key || ''))) {
        const error = new Error('key 必须是 8 位 Zotero key');
        error.status = 400;
        error.code = 'bad_request';
        throw error;
      }
      if (page && (!Number.isInteger(Number(page)) || Number(page) < 1 || Number(page) > 100000)) {
        const error = new Error('page 必须是 1..100000 的整数');
        error.status = 400;
        error.code = 'bad_request';
        throw error;
      }
      let url;
      if (kind === 'pdf') {
        const target = keyPattern.test(String(attachmentKey || '')) ? attachmentKey : key;
        const params = [];
        if (page) params.push(`page=${Number(page)}`);
        if (annotationKey) params.push(`annotation=${String(annotationKey).replace(/[^A-Z0-9]/g, '')}`);
        url = `zotero://open-pdf/library/items/${target}${params.length ? `?${params.join('&')}` : ''}`;
      } else if (kind === 'item') {
        url = `zotero://select/library/items/${key}`;
      } else {
        const error = new Error('kind 只支持 item 或 pdf');
        error.status = 400;
        error.code = 'bad_request';
        throw error;
      }
      return { ok: true, url, opened: false, mock: true };
    },

    async citation({ id } = {}) {
      ensureOk();
      const record = CITATION_RECORDS.find((entry) => entry.id === String(id || ''));
      if (!record) {
        const error = new Error(`找不到引文记录：${id}`);
        error.status = 404;
        error.code = 'citation_not_found';
        throw error;
      }
      return record;
    },

    async citationsForItem({ itemKey = '', limit = 20 } = {}) {
      ensureOk();
      const records = CITATION_RECORDS.filter((entry) => entry.itemKey === String(itemKey || '')).slice(
        0,
        Math.max(1, Math.min(100, Number(limit) || 20)),
      );
      if (!records.length) {
        const error = new Error(`找不到该文献的引文记录：${itemKey}`);
        error.status = 404;
        error.code = 'citations_not_found';
        throw error;
      }
      return { itemKey: String(itemKey), total: records.length, records };
    },

    async saveCitationAnnotation() {
      ensureOk();
      const error = new Error('需要 Zotero 10 才能把引文保存为 Zotero 阅读高亮（dev mock 占位接口）');
      error.status = 501;
      error.code = 'requires-zotero-10';
      throw error;
    },

    collectionNames() {
      return collectionNames;
    },
  };
}

export const MOCK_ITEM_COUNT = MOCK_ITEMS.length;
export const MOCK_COLLECTION_COUNT = COLLECTIONS.length;
