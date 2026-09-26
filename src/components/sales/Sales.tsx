import React, { useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
import SalesList from './SalesList';
import SalesForm from './SalesForm';
import SaleDetailModal from './SaleDetailModal';
import { useAuth } from '../../App';
import { Button, Card, PageHeader } from '../ui';

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
          <Card padding="md" className="rounded-3xl shadow-lg">
            <PageHeader
              title="Sipariş Yönetimi"
              description="Satış, kargo ve sipariş takip süreçleri"
              actions={!isReadOnly ? <Button
                onClick={() => setShowForm(true)}
                className="rounded-2xl px-6 py-3 font-bold shadow-soft hover:-translate-y-0.5 hover:shadow-lg"
              >
                <Plus className="w-5 h-5" />
                <span>Yeni Satış Ekle</span>
              </Button> : undefined}
            />
          </Card>

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
