import React, { useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
import SalesList from './SalesList';
import SalesForm from './SalesForm';
import SaleDetailModal from './SaleDetailModal';
import { useAuth } from '../../App';

export default function Sales() {
  const { isReadOnly } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [selectedSale, setSelectedSale] = useState<any>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSaleUpdated = () => {
    setRefreshKey((key) => key + 1);
  };

  return (
    <div className="space-y-6 animate-in fade-in">
      {!showForm ? (
        <>
          <div className="flex justify-between items-center bg-white p-6 rounded-3xl shadow-lg border border-border-color">
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center">
                <ShoppingCart className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-black text-text-main flex items-center tracking-tight">Sipariş Yönetimi</h1>
                <p className="text-text-muted mt-1 font-medium">Satış, kargo ve sipariş takip süreçleri</p>
              </div>
            </div>
            {!isReadOnly && (
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center space-x-2 bg-primary text-white px-6 py-3 rounded-2xl font-bold shadow-soft hover:shadow-lg hover:-translate-y-0.5 transition-all"
              >
                <Plus className="w-5 h-5" />
                <span>Yeni Satış Ekle</span>
              </button>
            )}
          </div>

          <SalesList refreshKey={refreshKey} onSaleClick={setSelectedSale} />
          {selectedSale && (
            <SaleDetailModal
              sale={selectedSale}
              onClose={() => setSelectedSale(null)}
              onUpdated={handleSaleUpdated}
            />
          )}
        </>
      ) : (
        isReadOnly ? null : <SalesForm onBack={() => setShowForm(false)} />
      )}
    </div>
  );
}
