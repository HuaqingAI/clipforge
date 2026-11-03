import { resolveTideweShopCategory, type TideweShopCategory } from "./categories";

interface CategoryExamples {
  label: string;
  copyAngles: string[];
  visualExamples: { context: string; ordinaryUse: string; detail: string };
  productFocusExample: string;
  contactAndFocus: string;
  evidenceLimits: string;
}

const ENVIRONMENT_FOCUS = "保留现有环境：近处与中景清楚可辨；轻微柔化只允许用于主体后方的远背景，其原有结构仍可读；不添加原场景没有的景物。所有景别（包括近景和特写）中，原画面已有近处地面、台面或支撑面从画面下边缘延伸至可见接触处时，该段连续区域自然清楚可读，不允许画面底边模糊带。主体前方全部已有前景均清楚可读，包括不与商品或支撑面相连的独立近物及画幅边缘，没有近物失焦例外；不新增原画面不存在的支撑或场景，不要求所有距离同等锐利。";

export const TIDEWE_REFERENCE_APPEARANCE_POLICY = "适用于所有户外品类及未选品类：参考图和外观记录中清楚可见的部件、形状、纹理、布局、位置、连接与接触关系，均可直接用于整体、近景和特写，无须另有已确认性能事实。逐图依据实际主体识别，局部参考图重点展示的部位优先，不因整体图或旧摘要未提及而忽略，也不按固定部件清单筛选。按当前商品实际可见内容选择画面；品类示例是可选观察方向，不是部件清单或允许拍摄的范围，也不证明商品具备示例中的部件。可见结构不自动证明隐藏机构、操作顺序、功能、性能或购买条件，这些声明仍需相应商品资料。画面字段直接描述实际入画对象与动作，不夹带未经确认、待核实、不特写等审核措辞。";

const EXAMPLES: Record<TideweShopCategory, CategoryExamples> = {
  hunting_blind: {
    label: "狩猎帐篷",
    copyAngles: ["围绕当前帐篷有依据的进出、等候或观察处境，用已确认功能说明对应的实际使用收益；参考支持的布置、空间或开口细节可让购买理由更具体。"],
    visualExamples: {
      context: "参考中的帐篷完整立在现有营位，保留真实尺寸与周围空间。",
      ordinaryUse: "人物已站在参考支持的现有入口旁，扶住可见边缘并完成一个小幅普通操作。",
      detail: "近看参考支持的门窗开口形状与边缘、可见扣件、面料接缝或支架连接，保留其位置、连接和手部接触关系。",
    },
    productFocusExample: "参考中的帐篷入口边缘与人物手部接触处，或实际可见窗缘、扣件与支架接点，构图包含该部件及邻近支撑。",
    contactAndFocus: `帐篷底边、现有支撑与附近地面共享透视和接触阴影；入口、手和同焦平面的面料连贯清楚。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "门窗的可见形状、位置与连接可按图呈现；图中未展示的开合机构不猜测，可视角度、透视能力、隔音或防风防雨性能须有商品资料支持。",
  },
  waders: {
    label: "涉水服",
    copyAngles: ["围绕资料支持的穿着准备或实际使用处境，将参考可见的结构、已确认的功能与有依据的使用收益联系起来；参考支持的版型和连接细节可用于具体说明。"],
    visualExamples: {
      context: "人物在平稳干燥岸边穿好参考中的涉水服，展示整体穿着关系。",
      ordinaryUse: "手已搭在参考支持的现有背带或扣件，作一次小幅整理后停稳。",
      detail: "观察参考中可见的背带、扣件、胸前口袋、接缝或脚部连接，保留部件的实际位置、连接布局及衣料与身体的自然接触。",
    },
    productFocusExample: "参考中的涉水服可见背带连接与接触的手，或胸前口袋、接缝及脚部连接，包含该部件的邻近衣料和身体支撑。",
    contactAndFocus: `涉水服与身体贴合、手部接触和脚下支撑连贯，主体附近地面与同焦平面衣料自然可辨。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "不以普通穿着或岸边镜头证明防水、保温或安全水深；不由连体外形推断隐藏结构，不安排危险水流测试。",
  },
  heated_gear: {
    label: "加热装备",
    copyAngles: ["围绕当前装备有依据的寒冷环境使用需求，用已确认的功能、实际形态和使用条件说明它能带来的具体帮助；加热部位、档位、续航或供电优势仅在当前商品事实支持时作为购买理由。"],
    visualExamples: {
      context: "在真实户外使用位置展示当前参考中的加热装备整体，保留它实际的穿戴或支撑方式。",
      ordinaryUse: "人物按当前装备的真实用途穿戴、持握或使用，手已接触一个参考支持的可见部位。",
      detail: "优先近看局部参考图实际展示的部位，保留其可见形状、表面与连接；也可观察当前装备参考中已有的面料或接触关系。",
    },
    productFocusExample: "参考中当前加热装备局部图实际展示的部位，保留其布局、所在位置与邻近表面或接触处的关系。",
    contactAndFocus: `按实际产品形态保持穿戴贴合或支撑接触，手、装备表面和同焦平面环境共享细节、曝光与阴影。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "加热装备不等于加热衣服；不默认加热区、温度、档位、续航或附送电池。只用当前已确认事实说明功能，不用发光、热成像或剖面制造证据。",
  },
  apparel: {
    label: "服装",
    copyAngles: ["围绕当前服装的实际穿着或搭配处境，直接讲清已确认功能、版型或有依据的面料细节如何回应使用需求；购买理由应落在当前商品支持的具体用途和收益上。"],
    visualExamples: {
      context: "人物在真实使用环境中穿着参考服装，以适当景别显示整件衣服与身体的关系。",
      ordinaryUse: "人物整理当前衣服已有的袖口或衣摆，或做一次自然抬臂，保持衣料随身体受力。",
      detail: "近看参考中可见的拉链、口袋、袖口、调节扣件、面料纹理或接缝，保留实际布局；手部可轻触对应现有部件并呈现自然褶皱。",
    },
    productFocusExample: "参考服装的现有拉链、口袋、袖口、扣件或衣料接缝及接触的手，构图保留该部件的实际位置与邻近穿着部位。",
    contactAndFocus: `衣料随身体受压和褶皱，手、面料与同焦平面周边清晰度一致，人物边缘不出现人像蒙版虚化。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "参考可见的迷彩图案、扣件和衣料结构可原样展示；加热、防水、保暖或降噪功能须有商品资料支持，触摸和抬臂不能证明长期舒适或耐用。",
  },
  boots: {
    label: "靴子",
    copyAngles: ["围绕当前靴子有依据的穿着和行走处境，用已确认功能说明对应的使用收益；靴筒、筒口或鞋底外观可作具体说明，性能理由须有商品资料支持。"],
    visualExamples: {
      context: "人物穿着参考中的靴子站在平稳地面，构图容纳实际靴筒、脚与周围环境。",
      ordinaryUse: "已经穿好的靴子完成一次普通短步并停稳，或手轻整参考中已有的筒口部件。",
      detail: "在参考支持相应视角时观察靴筒、筒口、可见扣带、接缝、鞋底连接或外底纹理；保留实际位置、连接与接地关系，讨论哪个部位就将该部位实际纳入画面。",
    },
    productFocusExample: "参考中实际靴筒与小腿、筒口或扣带接触关系；讨论鞋底连接和外底纹理时，使用参考支持的对应视角。",
    contactAndFocus: `靴底、周围地面与现有落叶自然连贯；靴筒、接触的手和同焦平面表面可辨。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "靴子主类不等于防水靴或防蛇靴；普通踩踏和外底沟纹不证明防蛇咬、防水、抓地、认证或保温性能。",
  },
  accessories: {
    label: "配件",
    copyAngles: ["围绕当前配件资料支持的具体用途和使用处境，说明已确认功能或可见结构对实际使用有什么帮助，以当前商品自身的用途建立购买理由。"],
    visualExamples: {
      context: "在当前配件真实的携带或使用位置展示整体，保持与人物及环境的实际尺度。",
      ordinaryUse: "仅按商品名称与参考支持的用途持握、携带或接触当前配件，完成一个小幅普通动作。",
      detail: "近看当前配件参考中真实可见的部件、接缝或接触面；按当前物品选择已展示的光学镜片、调节件、背带或连接件等细节，保留实际位置与连接。",
    },
    productFocusExample: "当前配件参考中实际可见的部件及其支撑或手部接触关系；光学镜片、调节件、背带和连接件仅在当前物品参考已展示时采用。",
    contactAndFocus: `按当前配件实际的持握、穿戴或支撑方式保持接触阴影、透视与同焦平面细节一致。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "配件范围较广，不能仅因属于配件就默认是椅子、背包或测距仪；没有商品依据时不添加其他配件或功能。",
  },
};

const CHAIR_EXAMPLES: Partial<CategoryExamples> = {
  copyAngles: ["围绕当前椅子有依据的久坐、观察或户外使用处境，选择对使用者重要且有事实支持的需求，直接说明已确认功能带来的具体收益；真实坐姿、支撑位置与可见座面结构可让说明更具体，加热、旋转或调节等卖点仅在当前商品事实支持时采用。"],
  visualExamples: {
    context: "参考中的椅子放在平稳地面，构图显示完整座面、支撑与人物使用空间。",
    ordinaryUse: "人物已稳定坐在椅面上，保持受力与支撑，作一次自然姿态调整后停稳。",
    detail: "优先特写当前局部参考图实际展示的任一部位，保留其位置、连接和接触关系；也可观察参考中已有的座面边缘、支撑连接、侧袋或椅脚接地处。",
  },
  productFocusExample: "参考椅子局部图实际展示的部位及其真实布局与位置，或参考中的座面接触、支撑连接和椅脚触地关系。",
  contactAndFocus: `臀部与座面自然受压、椅脚接地有接触阴影，座面、手及同焦平面近处地面连贯清楚。${ENVIRONMENT_FOCUS}`,
  evidenceLimits: "不由坐下或按压证明承重、舒适、静音或加热性能；不默认可折叠、旋转或调节，不能坐着调整椅脚。",
};

/** Category examples guide possible pictures; current references and frozen shot intent always govern. */
export function buildTideweCategoryGuidance(category: unknown, context: { productName?: string | null; visualObservations?: string | null } = {}) {
  const resolved = resolveTideweShopCategory(category);
  const chair = (resolved === "accessories" || resolved === "heated_gear")
    && (/\bchairs?\b|椅/i.test(context.productName ?? "") || category === "hunting_chair");
  const examples = resolved ? EXAMPLES[resolved] : {
    label: "尚未选择品类",
    copyAngles: ["围绕当前商品资料支持的具体使用处境，将已确认功能或参考中可见的细节与有依据的使用收益联系起来，说明适合当前需求的购买理由。"],
    visualExamples: {
      context: "展示参考中当前商品与真实使用空间的关系。",
      ordinaryUse: "仅安排当前参考支持的小幅普通使用或静态观察。",
      detail: "观察当前参考中可见的部件或接触位置。",
    },
    productFocusExample: "当前商品参考支持的实际部件与接触关系。",
    contactAndFocus: `主体、商品及同焦平面的现有周边在光线、颗粒、边缘和接触阴影上连贯。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "未选品类时不推断商品类型、不借用其他品类特征；当前参考可见的结构与位置可直接展示，隐藏结构、功能和性能不由外观推断。",
  };
  return {
    category: resolved ?? "unspecified",
    ...examples,
    ...(chair ? { ...CHAIR_EXAMPLES, subtype: "chair" } : {}),
    // A heated chair still needs the main class's heating/evidence limits.
    ...(chair && resolved === "heated_gear" ? { evidenceLimits: `${EXAMPLES.heated_gear.evidenceLimits} ${CHAIR_EXAMPLES.evidenceLimits}` } : {}),
    referenceAppearancePolicy: TIDEWE_REFERENCE_APPEARANCE_POLICY,
    scope: "仅为当前品类的可选文案角度与画面示例，不是当前商品事实或固定镜头模板；文案不限定句式，人称、开头与叙述顺序随内容决定，可直接陈述处境、已确认功能和有依据的使用收益；仅采用商品资料和参考支持的结构、动作与性能。",
  };
}
