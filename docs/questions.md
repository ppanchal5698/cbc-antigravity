Here is the comprehensive, organized list of questions you need to send to the client (CBC) to resolve all pending dependencies, secure the required business logic, and unblock the system architecture phase.

### 1. Blueprint Extraction & AI Training

- **The "Golden Record":** Now that we have the "BUILDING PLANS-Dutch Bros 11-21-25.pdf", can you provide a finalized, completed quote that was generated specifically from this exact blueprint? We need this to serve as the baseline "Golden Record" to validate the AI's extraction accuracy against an expert human's output.
- **Fire Rating Identification:** In standard architectural sets like the Dutch Bros plans, where exactly do your estimators look for the fire rating (e.g., door schedule columns, specific architectural notes)? Additionally, which product categories require a price adjustment based on this rating?

---



### 2. Pricing Integration & Vendor Data

- **P21 System Access:** How exactly will the application interface with your P21 system for cost sourcing? Does P21 offer a secure REST API, or will we need to establish a direct SQL read-only connection?
- **Part-Number Reconciliation:** How does your team currently handle part-number mismatches between manufacturer catalogs and P21's internal item IDs (the known "semi/custom items" risk)?
- **Hager Live Data:** We received the "Hager Price Book #18." To ensure pricing never goes stale, does Hager provide a live API or data feed we can consume, or must we parse and rely on this static PDF?
- **Special Account Margins:** Which specific customer accounts (e.g., Wendy's) receive non-standard margins, and what are the exact mathematical rules or overrides for those accounts?
- **Light-Kit Logic:** Could you provide the specific logic, formulas, and multipliers for the glazing types and sizes from the National Guard, PEMKO, and Rockwood light-kit tables?

---



### 3. Excel Automation & Workflow Rules

- **Workbook Protection:** Thank you for providing the `ESTIMATOR` password for the Rick Gilbert and Shanna workbooks. Should the system programmatically open, populate, and re-encrypt these exact files on the fly, or will the application generate a fresh, unlocked Excel output that the estimators will manually lock prior to sending to the customer?
- **Alternates & Addenda:** For bid alternates and mid-project addenda (Requirement 4.1), how are these versions reconciled today? Should the database link addenda to a master project record as child revisions, or should they be treated as entirely separate, cloned quotes?
- **FRP Conversion Constants:** What are the exact mathematical constants used for the FRP wall panels (panel size, waste percentages, trim/stick lengths, adhesive coverage) so we can automate the Vu360 geometry conversions?
- **HP-Fabrication:** Can you clarify the exact terminology and scope for the HP-Fabrication "peelle/peeling" doors?
- **The Top-10 Stock List:** We still need the foundational "Top-10 stock list" per product type (locks, exits, closers, hinges) to build the core reference library and custom item picker.

---



### 4. IT Security & Project Governance

- **Data Security (NFR-4):** What is the approved, access-controlled IT environment where this application and the data extraction agent will be hosted?
- **Data Stewardship (NFR-10):** Who will hold the internal responsibility for refreshing the reference library, multiplier sheets, and margin sheets, and what is the expected refresh cadence to prevent stale quotes?
- **Target Metrics (Open Item 16):** To objectively measure the success of this build for leadership, what are the formal baseline and target metrics (e.g., current bids/month, hours/bid, expected turnaround times)?

