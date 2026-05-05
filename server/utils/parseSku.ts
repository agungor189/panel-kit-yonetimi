export type ParsedSku = {
  sku: string;
  material_code: string | null;
  material: string | null;
  series_code: string | null;
  series: string | null;
  tube_type_code: string | null;
  tube_type: string | null;
  size_code: string | null;
  size_label: string | null;
  form_code: string | null;
  form: string | null;
  is_component: boolean;
  is_accessory: boolean;
};

const MATERIAL_MAP: Record<string, string> = {
  AL: "Alüminyum",
  CI: "Demir Döküm",
  CS: "Karbon Çelik",
  PPR: "PPR",
};

const SERIES_MAP: Record<string, string> = {
  ALY: "ALY",
  OYA: "OYA",
  PRM: "PRM",
  STD: "STD",
  DRL: "DRL",
};

const TUBE_MAP: Record<string, string> = {
  RD: "Yuvarlak",
  SQ: "Kare",
};

const FORM_MAP: Record<string, string> = {
  ELB: "Elbow",
  TEE: "Tee",
  BAS: "Base",
  W3: "3 Way",
  W4: "4 Way",
  W5: "5 Way",
  W6: "6 Way",
  BW4: "Big 4 Way",
  LTEE: "Long Tee",
  CRS: "Cross",
  CPL: "Coupling",
  CPH: "Coupling With Screw Hole",
  T45: "45° Tee",
  RFE: "Roof Eaves",
  RFR: "Roof Ridge",
  STSW: "Short Tee Swivel",
  M173: "M173",
  SWJ: "Swivel Joint",
  SWT: "Swivel Tee",
  SWA: "Swivel A",
  SWB: "Swivel B",
};

const SIZE_LABEL_MAP: Record<string, string> = {
  "1IN": "1 inch",
  "34IN": "3/4 inch",
  "20": "20x20 mm",
  "30": "30x30 mm",
  "25": "25 mm",
  "40": "40x40 mm",
  "60": "60 mm",
};

export function parseSku(sku: string | null | undefined): ParsedSku {
  const empty: ParsedSku = {
    sku: sku || "",
    material_code: null,
    material: null,
    series_code: null,
    series: null,
    tube_type_code: null,
    tube_type: null,
    size_code: null,
    size_label: null,
    form_code: null,
    form: null,
    is_component: false,
    is_accessory: false,
  };
  if (!sku) return empty;

  const parts = sku.toUpperCase().trim().split("-");
  if (parts.length < 5) return { ...empty, sku };

  const [matCode, seriesCode, tubeCode, sizeCode, ...rest] = parts;
  const formCode = rest.join("-");

  const isHPart = /^H\d+$/.test(formCode) || formCode === "SWA" || formCode === "SWB";
  const isScrew = formCode.startsWith("SCR");

  const sizeLabel = (() => {
    if (SIZE_LABEL_MAP[sizeCode]) return SIZE_LABEL_MAP[sizeCode];
    if (/^\d+$/.test(sizeCode)) {
      if (tubeCode === "SQ") return `${sizeCode}x${sizeCode} mm`;
      return `${sizeCode} mm`;
    }
    if (sizeCode.endsWith("IN")) {
      const num = sizeCode.replace("IN", "");
      if (num === "1") return "1 inch";
      if (num === "34") return "3/4 inch";
      if (num === "12") return "1/2 inch";
      return `${num} inch`;
    }
    return sizeCode;
  })();

  return {
    sku,
    material_code: matCode,
    material: MATERIAL_MAP[matCode] ?? matCode,
    series_code: seriesCode,
    series: SERIES_MAP[seriesCode] ?? seriesCode,
    tube_type_code: tubeCode,
    tube_type: TUBE_MAP[tubeCode] ?? tubeCode,
    size_code: sizeCode,
    size_label: sizeLabel,
    form_code: formCode,
    form: FORM_MAP[formCode] ?? formCode,
    is_component: matCode === "CS" && (isHPart || formCode === "H13"),
    is_accessory: matCode === "CS" && isScrew,
  };
}

export function buildProductName(parsed: ParsedSku): string {
  if (!parsed.material) return parsed.sku;
  const parts: string[] = [];
  parts.push(parsed.material);
  if (parsed.tube_type) parts.push(parsed.tube_type);
  parts.push("Boru Kelepçesi");
  if (parsed.form) parts.push(parsed.form);
  if (parsed.size_label) parts.push(parsed.size_label);
  return parts.join(" ");
}
