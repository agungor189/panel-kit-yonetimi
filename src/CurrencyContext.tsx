import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from './lib/api';

export type CurrencyView = 'TRY' | 'USD' | 'TL+USD';

interface CurrencyContextType {
  viewCurrency: CurrencyView;
  setViewCurrency: (val: CurrencyView) => void;
  activeRate: number;
  rateSource: string | null;
  rateFetchedAt: string | null;
  isRateLoading: boolean;
  isRateError: boolean;
  refreshRate: () => Promise<void>;
  fetchRate: () => Promise<void>;
  FormatAmount: React.FC<{
    amount: number;
    originalCurrency?: 'TRY' | 'USD';
    exchangeRateAtTransaction?: number;
    className?: string;
    align?: 'left' | 'right' | 'center';
  }>;
}

const CurrencyContext = createContext<CurrencyContextType>({
  viewCurrency: 'TRY',
  setViewCurrency: () => {},
  activeRate: 1,
  rateSource: null,
  rateFetchedAt: null,
  isRateLoading: false,
  isRateError: false,
  refreshRate: async () => {},
  fetchRate: async () => {},
  FormatAmount: () => <></>
});

export const CurrencyProvider = ({ children }: { children: React.ReactNode }) => {
  const [viewCurrency, setViewCurrency] = useState<CurrencyView>('TRY');
  const [activeRate, setActiveRate] = useState<number>(1);
  const [rateSource, setRateSource] = useState<string | null>(null);
  const [rateFetchedAt, setRateFetchedAt] = useState<string | null>(null);
  const [isRateLoading, setIsRateLoading] = useState(false);
  const [isRateError, setIsRateError] = useState(false);

  const fetchRate = async () => {
    try {
      setIsRateLoading(true);
      setIsRateError(false);
      const res = await api.get('/exchange-rate');
      if (res?.rate) {
        setActiveRate(res.rate);
        setRateSource(res.source || null);
        setRateFetchedAt(res.fetched_at || null);
      }
    } catch(e) {
      console.error("Fetch rate error:", e);
      setIsRateError(true);
    } finally {
      setIsRateLoading(false);
    }
  };

  const refreshRate = async () => {
    try {
      setIsRateLoading(true);
      setIsRateError(false);
      const res = await api.post('/exchange-rate/refresh', {});
      if (res?.rate) {
        setActiveRate(res.rate);
        setRateSource(res.source || null);
        setRateFetchedAt(res.fetched_at || null);
      }
    } catch(e) {
      console.error("Refresh rate error:", e);
      setIsRateError(true);
    } finally {
      setIsRateLoading(false);
    }
  };

  const FormatAmount: React.FC<{
    amount: number;
    originalCurrency?: 'TRY' | 'USD';
    exchangeRateAtTransaction?: number;
    className?: string;
    align?: 'left' | 'right' | 'center';
  }> = ({ amount, originalCurrency = 'TRY', exchangeRateAtTransaction, className, align = 'left' }) => {
    const rateToUse = exchangeRateAtTransaction || activeRate || 1;

    let tryAmount = amount;
    let usdAmount = amount;

    if (originalCurrency === 'TRY') {
      tryAmount = amount;
      usdAmount = rateToUse > 0 ? amount / rateToUse : 0;
    } else {
      usdAmount = amount;
      tryAmount = amount * rateToUse;
    }

    const formatMoney = (val: number, cur: string) => {
       const str = val.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
       return cur === 'TRY' ? `₺${str}` : `$${str}`;
    };

    if (viewCurrency === 'TRY') {
      return <span className={className}>{formatMoney(tryAmount, 'TRY')}</span>;
    }
    
    if (viewCurrency === 'USD') {
      return <span className={className}>{formatMoney(usdAmount, 'USD')}</span>;
    }

    const alignmentClass = align === 'right' ? 'items-end text-right' : align === 'center' ? 'items-center text-center' : 'items-start text-left';

    // TL+USD Mode
    return (
      <span className={`inline-flex flex-col justify-center ${alignmentClass} leading-[1.1] ${className || ''}`}>
        <span className="block">{formatMoney(tryAmount, 'TRY')}</span>
        <span className="block text-[1em] text-gray-700 font-bold tracking-tight relative mt-1">
          ({formatMoney(usdAmount, 'USD')})
        </span>
      </span>
    );
  };

  return (
    <CurrencyContext.Provider value={{
      viewCurrency,
      setViewCurrency,
      activeRate,
      rateSource,
      rateFetchedAt,
      isRateLoading,
      isRateError,
      refreshRate,
      fetchRate,
      FormatAmount
    }}>
      {children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = () => useContext(CurrencyContext);
