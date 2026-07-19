/**
 * PostNL API-client (Barcode + Labelling v2_2).
 * Sandbox of productie wordt bepaald door POSTNL_API_BASE in .env.
 * Docs: https://developer.postnl.nl → Send & Track.
 */

export type PostnlConfig = {
  apiKey: string;
  apiBase: string;
  customerNumber: string;
  customerCode: string;
  collectionLocation: string;
  barcodeSerie: string;
  sender: {
    company: string;
    street: string;
    houseNr: string;
    zip: string;
    city: string;
    email: string;
  };
};

export function postnlConfigFromEnv(): PostnlConfig {
  const required = [
    "POSTNL_API_KEY",
    "POSTNL_CUSTOMER_NUMBER",
    "POSTNL_CUSTOMER_CODE",
    "POSTNL_COLLECTION_LOCATION",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`PostNL: ontbrekende env-variabele ${key}`);
    }
  }
  return {
    apiKey: process.env.POSTNL_API_KEY!,
    apiBase: process.env.POSTNL_API_BASE ?? "https://api-sandbox.postnl.nl",
    customerNumber: process.env.POSTNL_CUSTOMER_NUMBER!,
    customerCode: process.env.POSTNL_CUSTOMER_CODE!,
    collectionLocation: process.env.POSTNL_COLLECTION_LOCATION!,
    barcodeSerie: process.env.POSTNL_BARCODE_SERIE ?? "00000000-99999999",
    sender: {
      company: process.env.POSTNL_SENDER_COMPANY ?? "Gradepurity",
      street: process.env.POSTNL_SENDER_STREET ?? "",
      houseNr: process.env.POSTNL_SENDER_HOUSENR ?? "",
      zip: process.env.POSTNL_SENDER_ZIP ?? "",
      city: process.env.POSTNL_SENDER_CITY ?? "",
      email: process.env.POSTNL_SENDER_EMAIL ?? "",
    },
  };
}

/** Productcodes: NL standaard = 3085, België thuisadres = 4946. */
export function productCodeFor(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  if (cc === "NL") return "3085";
  if (cc === "BE") return "4946";
  throw new Error(`PostNL: geen productcode geconfigureerd voor land ${cc}`);
}

async function postnlFetch(
  cfg: PostnlConfig,
  path: string,
  init?: RequestInit
): Promise<any> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: {
      apikey: cfg.apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `PostNL ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`
    );
  }
  return json;
}

/** Genereert een 3S-barcode (track & trace-nummer) voor NL/BE. */
export async function generateBarcode(cfg: PostnlConfig): Promise<string> {
  const params = new URLSearchParams({
    CustomerCode: cfg.customerCode,
    CustomerNumber: cfg.customerNumber,
    Type: "3S",
    Serie: cfg.barcodeSerie,
  });
  const json = await postnlFetch(cfg, `/shipment/v1_1/barcode?${params}`);
  if (!json?.Barcode) {
    throw new Error(`PostNL barcode: onverwacht antwoord ${JSON.stringify(json)}`);
  }
  return json.Barcode as string;
}

export type LabelReceiver = {
  firstName?: string;
  lastName: string;
  company?: string;
  /** Straat + huisnummer + toevoeging als één regel (Medusa address_1). */
  streetHouseNr: string;
  zip: string;
  city: string;
  countryCode: string; // NL | BE
  email?: string;
  phone?: string;
};

export type LabelResult = {
  barcode: string;
  /** Base64-encoded PDF (A6-label). */
  labelPdfBase64: string;
};

/**
 * Maakt het verzendlabel aan en meldt de zending aan bij PostNL (confirm=true).
 * Gewicht in gram.
 */
export async function createLabel(
  cfg: PostnlConfig,
  receiver: LabelReceiver,
  opts: { barcode?: string; reference?: string; weightGrams?: number } = {}
): Promise<LabelResult> {
  const barcode = opts.barcode ?? (await generateBarcode(cfg));
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const body = {
    Customer: {
      Address: {
        AddressType: "02",
        CompanyName: cfg.sender.company,
        Street: cfg.sender.street,
        HouseNr: cfg.sender.houseNr,
        Zipcode: cfg.sender.zip,
        City: cfg.sender.city,
        Countrycode: "NL",
      },
      CollectionLocation: cfg.collectionLocation,
      CustomerCode: cfg.customerCode,
      CustomerNumber: cfg.customerNumber,
      Email: cfg.sender.email,
    },
    Message: {
      MessageID: "1",
      MessageTimeStamp: timestamp,
      Printertype: "GraphicFile|PDF",
    },
    Shipments: [
      {
        Addresses: [
          {
            AddressType: "01",
            FirstName: receiver.firstName ?? "",
            Name: receiver.lastName,
            CompanyName: receiver.company ?? "",
            StreetHouseNrExt: receiver.streetHouseNr,
            Zipcode: receiver.zip.replace(/\s+/g, ""),
            City: receiver.city,
            Countrycode: receiver.countryCode.toUpperCase(),
          },
        ],
        Barcode: barcode,
        Contacts: [
          {
            ContactType: "01",
            Email: receiver.email ?? "",
            SMSNr: receiver.phone ?? "",
          },
        ],
        Dimension: { Weight: opts.weightGrams ?? 500 },
        ProductCodeDelivery: productCodeFor(receiver.countryCode),
        Reference: opts.reference ?? "",
      },
    ],
  };

  const json = await postnlFetch(cfg, `/shipment/v2_2/label?confirm=true`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const shipment = json?.ResponseShipments?.[0];
  const label = shipment?.Labels?.find((l: any) => l?.Content) ?? shipment?.Labels?.[0];
  if (!label?.Content) {
    throw new Error(
      `PostNL label: geen label in antwoord ${JSON.stringify(json).slice(0, 800)}`
    );
  }
  return { barcode: shipment.Barcode ?? barcode, labelPdfBase64: label.Content };
}

/** Publieke track & trace-URL voor de klant. */
export function trackingUrl(
  barcode: string,
  countryCode: string,
  zip: string
): string {
  const cc = countryCode.toUpperCase();
  const cleanZip = zip.replace(/\s+/g, "").toUpperCase();
  return `https://jouw.postnl.nl/track-and-trace/${barcode}-${cc}-${cleanZip}`;
}
