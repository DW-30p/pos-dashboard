// server.js - Backend API Completo (Caja Calculada + Valor Inventario)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test de conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a la base de datos:', err.stack);
  } else {
    console.log('✅ Conexión exitosa a la base de datos');
    release();
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API funcionando correctamente' });
});

// =====================================================
// DASHBOARD - ESTADÍSTICAS GENERALES (MODIFICADO)
// =====================================================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).json({ error: 'Se requieren fechas de inicio y fin (start_date, end_date).' });
    }
    
    // --- CÁLCULO DE CAJA DEL DÍA (O PERÍODO) ---
    // Esta sección ahora calcula siempre, no solo para un día
    const periodBudgetQuery = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as initial_budget
      FROM initial_budgets
      WHERE date BETWEEN $1 AND $2
    `, [start_date, end_date]);
    
    const periodCashSalesQuery = await pool.query(`
      SELECT COALESCE(SUM(total), 0) as cash_sales
      FROM sales
      WHERE date::date BETWEEN $1 AND $2 AND payment_method = 'cash'
    `, [start_date, end_date]);

    const periodDisbursementsQuery = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_disbursements
      FROM disbursements
      WHERE created_at::date BETWEEN $1 AND $2
    `, [start_date, end_date]);

    const period_initial_budget = parseFloat(periodBudgetQuery.rows[0].initial_budget);
    const period_cash_sales = parseFloat(periodCashSalesQuery.rows[0].cash_sales);
    const period_total_disbursements = parseFloat(periodDisbursementsQuery.rows[0].total_disbursements);
    const calculated_period_balance = (period_initial_budget + period_cash_sales) - period_total_disbursements;
    
    // Mantenemos la lógica 'dailyCash' solo para mostrar el resumen detallado si es un día
    let dailyCashData = { is_daily: false };
    if (start_date === end_date) {
        dailyCashData = {
          is_daily: true,
          initial_budget: period_initial_budget,
          cash_sales: period_cash_sales,
          total_disbursements: period_total_disbursements,
          expected_cash: calculated_period_balance // El cálculo es el mismo
        };
    }
    // --- FIN DE CÁLCULO DE CAJA ---

    // Ventas del período (Conteo y Total de Venta)
    const salesQuery = await pool.query(`
      SELECT 
        COUNT(*) as sales_count,
        COALESCE(SUM(total), 0) as total_sales
      FROM sales
      WHERE date::date BETWEEN $1 AND $2
    `, [start_date, end_date]);

    // Ganancia y Subtotal del período desde sale_items
    const profitAndSubtotalQuery = await pool.query(`
      SELECT 
        COALESCE(SUM((si.unit_price - si.unit_cost) * si.quantity), 0) as total_profit,
        COALESCE(SUM(si.subtotal), 0) as total_subtotal
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
    `, [start_date, end_date]);

    // Fiados pendientes (Total)
    const fiadosQuery = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_fiados FROM fiados WHERE amount > 0
    `);

    // Productos más vendidos
    const topProductsQuery = await pool.query(`
      SELECT 
        COALESCE(p.name, si.product_name) as product_name,
        SUM(si.quantity) as total_quantity,
        SUM(si.subtotal) as total_revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN products p ON si.product_id = p.id
      WHERE s.date::date BETWEEN $1 AND $2
      GROUP BY COALESCE(p.name, si.product_name)
      HAVING COALESCE(p.name, si.product_name) IS NOT NULL
      ORDER BY total_revenue DESC
      LIMIT 10
    `, [start_date, end_date]);

    // Ventas recientes
    const recentSalesQuery = await pool.query(`
      SELECT id, date, total, ncf, payment_method
      FROM sales
      ORDER BY date DESC
      LIMIT 10
    `);

    // Productos con stock bajo
    const lowStockQuery = await pool.query(`
      SELECT name, stock, min_stock
      FROM products
      WHERE stock <= min_stock AND stock > 0 AND available = true
      ORDER BY stock ASC
      LIMIT 10
    `);

    // --- CÁLCULO: Valor Total del Inventario ---
    // Usa COALESCE para usar 'price' si 'cost' es NULL o 0
    const inventoryValueQuery = await pool.query(`
      SELECT COALESCE(SUM(stock * COALESCE(NULLIF(cost, 0), price)), 0) as total_inventory_value
      FROM products
      WHERE available = true AND stock > 0
    `);
    // --- FIN CÁLCULO ---

    res.json({
      dailyCash: dailyCashData,
      sales: {
        ...salesQuery.rows[0],
        total_subtotal: profitAndSubtotalQuery.rows[0].total_subtotal
      },
      profit: {
        total_profit: profitAndSubtotalQuery.rows[0].total_profit
      },
      calculatedPeriodBalance: calculated_period_balance,
      fiados: fiadosQuery.rows[0].total_fiados,
      topProducts: topProductsQuery.rows,
      recentSales: recentSalesQuery.rows,
      lowStock: lowStockQuery.rows,
      // --- DATO NUEVO EN RESPUESTA ---
      inventoryValue: inventoryValueQuery.rows[0].total_inventory_value
    });
  } catch (error) {
    console.error('Error en dashboard stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});

// =====================================================
// VENTAS, PRODUCTOS, REPORTES, CLIENTES/FIADOS
// =====================================================
app.get('/api/sales', async (req, res) => {
  try {
    const { start_date, end_date, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT 
        s.id, s.date, s.total, s.subtotal, s.tax,
        s.payment_method, s.ncf,
        c.name as customer_name, u.username as user_name,
        (
            SELECT STRING_AGG(si.product_name || ' (' || si.quantity || ')', ', ') 
            FROM sale_items si 
            WHERE si.sale_id = s.id
        ) as items_summary 
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date && end_date) {
      query += ` AND s.date::date BETWEEN $${params.length + 1} AND $${params.length + 2}`;
      params.push(start_date, end_date);
    } else {
      return res.status(400).json({ error: 'Se requieren fechas de inicio y fin.' });
    }
    
    query += ` ORDER BY s.date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    res.json({
      sales: result.rows,
      total: result.rowCount
    });
  } catch (error) {
    console.error('Error al obtener ventas:', error);
    res.status(500).json({ error: 'Error al obtener ventas', details: error.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { search, category_id, low_stock } = req.query;
    
    let query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.available = true
    `;
    
    const params = [];
    
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`;
    }
    
    if (category_id) {
      params.push(category_id);
      query += ` AND p.category_id = $${params.length}`;
    }
    
    if (low_stock === 'true') {
      query += ` AND p.stock <= p.min_stock`;
    }
    
    query += ` ORDER BY p.name`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

app.get('/api/products/stats', async (req, res) => {
  try {
    const totalProducts = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE available = true
    `);
    
    const lowStock = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE stock <= min_stock AND stock > 0 AND available = true
    `);
    
    const outOfStock = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE stock = 0 AND available = true
    `);
    
    res.json({
      total: parseInt(totalProducts.rows[0].total),
      lowStock: parseInt(lowStock.rows[0].total),
      outOfStock: parseInt(outOfStock.rows[0].total)
    });
  } catch (error) {
    console.error('Error en stats de productos:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

app.get('/api/reports/profit', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
        return res.status(400).json({ error: 'Se requieren fechas.' });
    }
    
    const dailyResult = await pool.query(`
      SELECT 
        DATE(s.date) as sale_date,
        SUM(si.subtotal) as total_revenue,
        SUM(si.unit_cost * si.quantity) as total_cost,
        SUM((si.unit_price - si.unit_cost) * si.quantity) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
      GROUP BY DATE(s.date)
      ORDER BY sale_date DESC
    `, [start_date, end_date]);

    const totalsResult = await pool.query(`
      SELECT 
        SUM(si.subtotal) as total_revenue,
        SUM(si.unit_cost * si.quantity) as total_cost,
        SUM((si.unit_price - si.unit_cost) * si.quantity) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
    `, [start_date, end_date]);
    
    const totals = totalsResult.rows[0];
    const margin = (totals.total_revenue > 0) 
      ? ((totals.total_profit / totals.total_revenue) * 100).toFixed(2) 
      : 0;

    res.json({
      daily: dailyResult.rows,
      totals: { ...totals, profit_margin: margin }
    });
    
  } catch (error) {
    console.error('Error en reporte de ganancias:', error);
    res.status(500).json({ error: 'Error al generar reporte' });
  }
});

app.get('/api/reports/payment-methods', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
        return res.status(400).json({ error: 'Se requieren fechas.' });
    }
    
    const result = await pool.query(`
      SELECT 
        payment_method,
        COUNT(*) as transaction_count,
        SUM(total) as total_amount
      FROM sales
      WHERE date::date BETWEEN $1 AND $2
      GROUP BY payment_method
      ORDER BY total_amount DESC
    `, [start_date, end_date]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error en reporte de métodos de pago:', error);
    res.status(500).json({ error: 'Error al generar reporte' });
  }
});

app.get('/api/reports/disbursements', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'Se requieren fechas.' });
    }
    
    const detailsQuery = await pool.query(`
      SELECT d.amount, d.reason, d.created_at, COALESCE(u.first_name || ' ' || u.last_name, u.username) as user_name
      FROM disbursements d
      LEFT JOIN users u ON d.user_id = u.id
      WHERE d.created_at::date BETWEEN $1 AND $2
      ORDER BY d.created_at DESC
    `, [start_date, end_date]);
    
    const summaryQuery = await pool.query(`
      SELECT 
        reason, 
        COUNT(*) as count, 
        SUM(amount) as total_amount
      FROM disbursements
      WHERE created_at::date BETWEEN $1 AND $2
      GROUP BY reason
      ORDER BY total_amount DESC
    `, [start_date, end_date]);

    res.json({
      details: detailsQuery.rows,
      summary: summaryQuery.rows,
      total: summaryQuery.rows.reduce((acc, row) => acc + parseFloat(row.total_amount), 0)
    });

  } catch (error) {
    console.error('Error en reporte de desembolsos:', error);
    res.status(500).json({ error: 'Error al generar reporte', details: error.message });
  }
});

app.get('/api/reports/stagnant-products', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'Se requieren fechas.' });
    }
    const result = await pool.query(`
      SELECT 
        p.name, 
        p.stock, 
        p.price, 
        p.cost, 
        c.name as category_name,
        (p.stock * p.cost) as cost_in_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.available = true AND p.id NOT IN (
        SELECT DISTINCT si.product_id 
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        WHERE s.date::date BETWEEN $1 AND $2
        AND si.product_id IS NOT NULL
      )
      ORDER BY p.name;
    `, [start_date, end_date]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en reporte de productos estancados:', error);
    res.status(500).json({ error: 'Error al generar reporte', details: error.message });
  }
});

app.get('/api/reports/sales-by-user', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'Se requieren fechas.' });
    }
    const result = await pool.query(`
      SELECT 
        COALESCE(u.first_name || ' ' || u.last_name, u.username) as user_name,
        COUNT(s.id) as transaction_count,
        SUM(s.total) as total_revenue
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.date::date BETWEEN $1 AND $2
      GROUP BY COALESCE(u.first_name || ' ' || u.last_name, u.username)
      ORDER BY total_revenue DESC;
    `, [start_date, end_date]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en reporte de ventas por usuario:', error);
    res.status(500).json({ error: 'Error al generar reporte', details: error.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const { search } = req.query;
    
    let query = `
      SELECT c.*, COALESCE(SUM(f.amount), 0) as total_fiados
      FROM customers c
      LEFT JOIN fiados f ON c.id = f.customer_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.cedula ILIKE $1)`;
    }
    
    query += ` GROUP BY c.id ORDER BY c.name`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener clientes:', error);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

app.get('/api/fiados/pending', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id, 
        c.name, 
        c.phone, 
        c.cedula,
        COALESCE(SUM(f.amount), 0) as total_fiado
      FROM customers c
      LEFT JOIN fiados f ON c.id = f.customer_id
      GROUP BY c.id
      HAVING COALESCE(SUM(f.amount), 0) > 0
      ORDER BY total_fiado DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener fiados pendientes:', error);
    res.status(500).json({ error: 'Error al obtener fiados pendientes', details: error.message });
  }
});

// =====================================================
// SERVIDOR
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📊 Dashboard disponible en http://localhost:${PORT}`);
});