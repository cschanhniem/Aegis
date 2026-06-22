#!/usr/bin/env python3
"""Set up the Miro demo database with realistic data."""

import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "miro.db")


def setup():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    # Remove old DB so we start fresh
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # ── customers table ─────────────────────────────────────
    c.execute("""
        CREATE TABLE customers (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            revenue REAL,
            industry TEXT,
            employees INTEGER,
            region TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    customers = [
        (1, "Acme Corp", "contact@acme.com", 2500000, "Technology", 340, "North America"),
        (2, "GlobalTech Solutions", "info@globaltech.eu", 1800000, "SaaS", 210, "Europe"),
        (3, "DataFlow Inc", "hello@dataflow.io", 1450000, "Analytics", 125, "North America"),
        (4, "CloudNine Systems", "sales@cloudnine.sg", 1200000, "Infrastructure", 180, "Asia Pacific"),
        (5, "Nexus AI", "team@nexusai.com", 980000, "AI/ML", 95, "North America"),
        (6, "SecureStack", "contact@securestack.de", 870000, "Cybersecurity", 150, "Europe"),
        (7, "MedTech Pro", "admin@medtechpro.com", 750000, "Healthcare", 200, "North America"),
        (8, "FinServe Global", "ops@finserve.co.uk", 2100000, "Fintech", 310, "Europe"),
        (9, "EduPlatform", "support@eduplatform.jp", 420000, "EdTech", 65, "Asia Pacific"),
        (10, "GreenEnergy AI", "info@greenenergy.ai", 650000, "CleanTech", 80, "North America"),
    ]
    c.executemany("INSERT INTO customers VALUES (?,?,?,?,?,?,?,datetime('now'))", customers)

    # ── orders table ────────────────────────────────────────
    c.execute("""
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER REFERENCES customers(id),
            product TEXT,
            amount REAL,
            status TEXT,
            ordered_at TEXT DEFAULT (datetime('now'))
        )
    """)

    orders = [
        (1, 1, "Enterprise Suite", 125000, "completed"),
        (2, 1, "AI Analytics Pro", 85000, "completed"),
        (3, 2, "Enterprise Suite", 95000, "completed"),
        (4, 3, "Data Pipeline", 67000, "pending"),
        (5, 4, "Cloud Migration", 110000, "completed"),
        (6, 5, "ML Platform", 72000, "in_progress"),
        (7, 6, "Security Audit", 45000, "completed"),
        (8, 7, "HIPAA Compliance", 88000, "completed"),
        (9, 8, "Risk Engine", 150000, "in_progress"),
        (10, 9, "LMS Premium", 32000, "completed"),
        (11, 10, "Carbon Tracker", 41000, "pending"),
        (12, 1, "Support Plan", 24000, "completed"),
        (13, 2, "Training Package", 18000, "completed"),
        (14, 8, "Payment Gateway", 95000, "completed"),
        (15, 3, "Dashboard Pro", 55000, "completed"),
    ]
    c.executemany("INSERT INTO orders VALUES (?,?,?,?,?,datetime('now'))", orders)

    # ── audit_log table (the target of the DROP TABLE demo) ─
    c.execute("""
        CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY,
            event TEXT,
            actor TEXT,
            detail TEXT,
            logged_at TEXT DEFAULT (datetime('now'))
        )
    """)

    audit_entries = [
        ("login", "admin", "Admin logged in from 10.0.1.5"),
        ("export", "analyst", "Exported Q1 revenue report"),
        ("policy_change", "admin", "Updated data retention to 90 days"),
        ("query", "miro-agent", "SELECT * FROM customers WHERE region='NA'"),
        ("login", "auditor", "Auditor logged in for quarterly review"),
        ("export", "admin", "Full customer list exported"),
        ("alert", "system", "Anomaly detected: 3x query spike from agent-07"),
        ("login", "miro-agent", "Agent session started"),
    ]
    c.executemany("INSERT INTO audit_log (event, actor, detail) VALUES (?,?,?)", audit_entries)

    # ── reviews table (for sentiment analysis demo) ─────────
    c.execute("""
        CREATE TABLE reviews (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER REFERENCES customers(id),
            rating INTEGER,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    reviews = [
        (1, 1, 5, "Excellent platform, transformed our workflow. The AI analytics caught issues we missed for months."),
        (2, 2, 4, "Great product overall. Onboarding was smooth, but documentation could be better."),
        (3, 3, 5, "DataFlow integration was seamless. Support team responded within an hour."),
        (4, 5, 3, "Decent ML capabilities but the UI feels dated. Would love a dashboard refresh."),
        (5, 6, 5, "Security audit tool is best in class. Found 12 vulnerabilities our previous scanner missed."),
        (6, 7, 4, "HIPAA compliance features saved us weeks of manual work. Very impressed."),
        (7, 8, 5, "Risk engine is phenomenal. Real-time fraud detection reduced losses by 40%."),
        (8, 4, 2, "Cloud migration was rocky. Two days of downtime during cutover. Not acceptable."),
        (9, 9, 4, "Students love the new LMS. Engagement metrics are up 25% since deployment."),
        (10, 10, 3, "Carbon tracking is useful but reporting needs work. Hard to export data."),
    ]
    c.executemany("INSERT INTO reviews VALUES (?,?,?,?,datetime('now'))", reviews)

    conn.commit()

    # Verify
    for table in ["customers", "orders", "audit_log", "reviews"]:
        count = c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {count} rows")

    conn.close()
    print(f"\nDatabase ready: {DB_PATH}")


if __name__ == "__main__":
    setup()
