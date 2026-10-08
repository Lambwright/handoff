import { useEffect, useState } from "react";
import { api } from "./api.js";

// The option lists every "select"-input gate task needs (region, timezone,
// currency, payment terms, fiscal year). Shared by every screen that can
// render GapResolution — the gate itself, and the two post-creation gap
// surfaces (ProjectView, HandoffBrief) a deferred select task can resurface
// on. One fetch-on-mount hook instead of copying the same five calls three
// times.
export function useGateOptions() {
  const [regionOptions, setRegionOptions] = useState([]);
  const [timezoneOptions, setTimezoneOptions] = useState([]);
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [paymentTermsOptions, setPaymentTermsOptions] = useState([]);
  const [fiscalYearOptions, setFiscalYearOptions] = useState([]);

  useEffect(() => {
    api.listRegions().then((d) => setRegionOptions(d.regions || [])).catch(() => {});
    api.listTimezones().then((d) => setTimezoneOptions((d.timezones || []).map((t) => ({ id: t, name: t })))).catch(() => {});
    api.listCurrencyOptions().then((d) => setCurrencyOptions(d.options || [])).catch(() => {});
    api.listPaymentTermsOptions().then((d) => setPaymentTermsOptions(d.options || [])).catch(() => {});
    api.listFiscalYearOptions().then((d) => setFiscalYearOptions(d.options || [])).catch(() => {});
  }, []);

  return { regionOptions, timezoneOptions, currencyOptions, paymentTermsOptions, fiscalYearOptions };
}
