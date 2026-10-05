-- Onboarding (05/10/2026): quien elige el plan Personal no tiene negocio. Su "tipo" es personal,
-- con categorías de la vida diaria (mercado, comida fuera, transporte, casa…).
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_business_type_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_business_type_check
  CHECK (business_type IN ('car_wash', 'food', 'retail', 'services', 'other', 'personal'));
