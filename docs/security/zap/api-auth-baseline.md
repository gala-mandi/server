# ZAP Scanning Report

ZAP by [Checkmarx](https://checkmarx.com/).


## Summary of Alerts

| Risk Level | Number of Alerts |
| --- | --- |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Informational | 3 |




## Insights

| Level | Reason | Site | Description | Statistic |
| --- | --- | --- | --- | --- |
| Low | Warning |  | ZAP warnings logged - see the zap.log file for details | 25    |
| Info | Informational | http://gm-staging-api:4100 | Percentage of responses with status code 2xx | 19 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of responses with status code 4xx | 80 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with content type application/json | 97 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with method DELETE | 4 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with method GET | 49 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with method PATCH | 11 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with method POST | 33 % |
| Info | Informational | http://gm-staging-api:4100 | Percentage of endpoints with method PUT | 1 % |
| Info | Informational | http://gm-staging-api:4100 | Count of total endpoints | 81    |
| Info | Informational | http://gm-staging-api:4100 | Percentage of slow responses | 7 % |







## Alerts

| Name | Risk Level | Number of Instances |
| --- | --- | --- |
| A Client Error response code was returned by the server | Informational | 65 |
| Information Disclosure - Sensitive Information in URL | Informational | 2 |
| Non-Storable Content | Informational | Systemic |




## Alert Detail



### [ A Client Error response code was returned by the server ](https://www.zaproxy.org/docs/alerts/100000/)



##### Informational (High)

### Description

A response code of 401 was returned by the server.
This may indicate that the application is failing to handle unexpected input correctly.
Raised by the 'Alert on HTTP Response Code Error' script

* URL: http://gm-staging-api:4100/admin/plans/id
  * Node Name: `http://gm-staging-api:4100/admin/plans/id`
  * Method: `DELETE`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/commodities/id
  * Node Name: `http://gm-staging-api:4100/commodities/id`
  * Method: `DELETE`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/staff/invitations/id
  * Node Name: `http://gm-staging-api:4100/staff/invitations/id`
  * Method: `DELETE`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/traders/id
  * Node Name: `http://gm-staging-api:4100/traders/id`
  * Method: `DELETE`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/plans%3Fpage=1&limit=50&search=ZAP&isActive=true&sort=priceMonthly
  * Node Name: `http://gm-staging-api:4100/admin/plans (isActive,limit,page,search,sort)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/plans/id
  * Node Name: `http://gm-staging-api:4100/admin/plans/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/stats
  * Node Name: `http://gm-staging-api:4100/admin/stats`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/stats/activity%3Flimit=20
  * Node Name: `http://gm-staging-api:4100/admin/stats/activity (limit)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/stats/inactive-shops%3Fpage=1&limit=20
  * Node Name: `http://gm-staging-api:4100/admin/stats/inactive-shops (limit,page)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/stats/new-shops%3Fmonths=12
  * Node Name: `http://gm-staging-api:4100/admin/stats/new-shops (months)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants%3Fpage=1&limit=20&search=ZAP&status=trial&sort=-createdAt
  * Node Name: `http://gm-staging-api:4100/admin/tenants (limit,page,search,sort,status)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/tenantId/audit-logs%3Fpage=1&limit=20&userId=userId&entity=entity&entityId=entityId&action=create&from=from&to=to
  * Node Name: `http://gm-staging-api:4100/admin/tenants/tenantId/audit-logs (action,entity,entityId,from,limit,page,to,userId)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/audit-logs%3Fpage=1&limit=20&userId=userId&entity=entity&entityId=entityId&action=create&from=from&to=to
  * Node Name: `http://gm-staging-api:4100/audit-logs (action,entity,entityId,from,limit,page,to,userId)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/commodities/id
  * Node Name: `http://gm-staging-api:4100/commodities/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/ledger/traderId%3Ffrom=from&to=to&page=1&limit=100
  * Node Name: `http://gm-staging-api:4100/ledger/traderId (from,limit,page,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/payments%3Fpage=1&limit=20&search=ZAP&from=from&to=to&direction=paid&trader=trader&method=cash&status=draft&sort=-paymentDate
  * Node Name: `http://gm-staging-api:4100/payments (direction,from,limit,method,page,search,sort,status,to,trader)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/payments/cash-book%3Ffrom=from&to=to
  * Node Name: `http://gm-staging-api:4100/payments/cash-book (from,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/payments/id
  * Node Name: `http://gm-staging-api:4100/payments/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/purchases%3Fpage=1&limit=20&search=ZAP&from=from&to=to&trader=trader&commodity=commodity&status=draft&sort=-purchaseDate
  * Node Name: `http://gm-staging-api:4100/purchases (commodity,from,limit,page,search,sort,status,to,trader)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/purchases/id
  * Node Name: `http://gm-staging-api:4100/purchases/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/rates%3Fpage=1&limit=20&commodity=commodity&from=from&to=to&sort=-rateDate
  * Node Name: `http://gm-staging-api:4100/rates (commodity,from,limit,page,sort,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/cash-book%3Ffrom=from&to=to
  * Node Name: `http://gm-staging-api:4100/reports/cash-book (from,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/commission%3Ffrom=from&to=to
  * Node Name: `http://gm-staging-api:4100/reports/commission (from,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/daily-summary%3Fdate=date
  * Node Name: `http://gm-staging-api:4100/reports/daily-summary (date)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/outstanding%3FasOf=asOf&type=kissan&limit=10
  * Node Name: `http://gm-staging-api:4100/reports/outstanding (asOf,limit,type)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/purchases%3Ffrom=from&to=to&groupBy=day&commodity=commodity&trader=trader
  * Node Name: `http://gm-staging-api:4100/reports/purchases (commodity,from,groupBy,to,trader)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/reports/sales%3Ffrom=from&to=to&groupBy=day&commodity=commodity&trader=trader
  * Node Name: `http://gm-staging-api:4100/reports/sales (commodity,from,groupBy,to,trader)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/sales%3Fpage=1&limit=20&search=ZAP&from=from&to=to&buyer=buyer&commodity=commodity&status=draft&sort=-saleDate
  * Node Name: `http://gm-staging-api:4100/sales (buyer,commodity,from,limit,page,search,sort,status,to)`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/sales/id
  * Node Name: `http://gm-staging-api:4100/sales/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/traders/id
  * Node Name: `http://gm-staging-api:4100/traders/id`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/plans/id
  * Node Name: `http://gm-staging-api:4100/admin/plans/id ()({name,maxUsers,maxBranches,priceMonthly,isActive})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id ()({name,city,address,phone,email,logoUrl})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id/subscription
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id/subscription ()({endsOn})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/commodities/id
  * Node Name: `http://gm-staging-api:4100/commodities/id ()({name,nameUr,category,defaultUnit,bagWeightKg:[],commissionPct:[],marketFeePct:[],labourPerBag:[],isActive})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/purchases/id
  * Node Name: `http://gm-staging-api:4100/purchases/id ()({traderId,purchaseDate,items:[{commodityId,bags,weightKg,rate,rateUnit}],charges:{commissionPct,marketFeePct,labourPerBag},paidAmount,notes})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/sales/id
  * Node Name: `http://gm-staging-api:4100/sales/id ()({buyerId,saleDate,items:[{commodityId,bags,weightKg,rate,rateUnit,purchaseItemId}],charges:{commissionPct,marketFeePct,labourPerBag},receivedAmount,notes})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/settings
  * Node Name: `http://gm-staging-api:4100/settings ()({"name":"ZAP","phone":"9999999999","email":zaproxy@example.com,"address":"688 Zaproxy Ridge","city":"East Romaineburgh","logoUrl":"John Doe","displayName":"John Doe","parchiFooter":"John Doe","defaultCommissionPct":"John Doe","marketFeePct":"John Doe","labourPerBag":"John Doe","defaultUnit":"kg","maundKg":"John Doe","language":"en","creditLimitAction":"warn","overpaymentAction":"advance","billPrefix":"John Doe","financialYearStart":"1970-01-01"})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/staff/id/role
  * Node Name: `http://gm-staging-api:4100/staff/id/role ()({role})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/traders/id
  * Node Name: `http://gm-staging-api:4100/traders/id ()({type,name,fatherName,phone:[],cnic:[],village,address,openingBalance,openingBalanceType,creditLimit,isActive,notes})`
  * Method: `PATCH`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/plans
  * Node Name: `http://gm-staging-api:4100/admin/plans ()({name,maxUsers,maxBranches,priceMonthly,isActive})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants
  * Node Name: `http://gm-staging-api:4100/admin/tenants ()({name,city,address,phone,email,owner:{name,phone,email}})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id/activate
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id/activate`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id/subscription
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id/subscription ()({planId,startsOn,endsOn,graceDays})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/admin/tenants/id/suspend
  * Node Name: `http://gm-staging-api:4100/admin/tenants/id/suspend`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/accept-invite
  * Node Name: `http://gm-staging-api:4100/auth/accept-invite ()({token,name,password})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/change-password
  * Node Name: `http://gm-staging-api:4100/auth/change-password ()({currentPassword,newPassword})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/login
  * Node Name: `http://gm-staging-api:4100/auth/login ()({identifier,password,rememberMe})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `401`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/refresh
  * Node Name: `http://gm-staging-api:4100/auth/refresh`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `401`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/reset-password
  * Node Name: `http://gm-staging-api:4100/auth/reset-password ()({phone,code,newPassword})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/commodities
  * Node Name: `http://gm-staging-api:4100/commodities ()({name,nameUr,category,defaultUnit,bagWeightKg:[],commissionPct:[],marketFeePct:[],labourPerBag:[],isActive})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/ledger/adjustments
  * Node Name: `http://gm-staging-api:4100/ledger/adjustments ()({traderId,side,amount,reason,entryDate})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/payments
  * Node Name: `http://gm-staging-api:4100/payments ()({direction,traderId,paymentDate,amount,method,reference,notes,allocations:[{purchaseId,saleId,amount}]})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/payments/id/cancel
  * Node Name: `http://gm-staging-api:4100/payments/id/cancel`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/purchases
  * Node Name: `http://gm-staging-api:4100/purchases ()({traderId,purchaseDate,items:[{commodityId,bags,weightKg,rate,rateUnit}],charges:{commissionPct,marketFeePct,labourPerBag},paidAmount,notes})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/purchases/id/cancel
  * Node Name: `http://gm-staging-api:4100/purchases/id/cancel`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/records/entity/id/restore
  * Node Name: `http://gm-staging-api:4100/records/entity/id/restore`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/sales
  * Node Name: `http://gm-staging-api:4100/sales ()({buyerId,saleDate,items:[{commodityId,bags,weightKg,rate,rateUnit,purchaseItemId}],charges:{commissionPct,marketFeePct,labourPerBag},receivedAmount,notes})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/sales/id/cancel
  * Node Name: `http://gm-staging-api:4100/sales/id/cancel`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/settings/logo
  * Node Name: `http://gm-staging-api:4100/settings/logo ()(multipart:file)`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/staff/id/activate
  * Node Name: `http://gm-staging-api:4100/staff/id/activate`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/staff/id/deactivate
  * Node Name: `http://gm-staging-api:4100/staff/id/deactivate`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/staff/invitations
  * Node Name: `http://gm-staging-api:4100/staff/invitations ()({phone,role,method,name})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `403`
  * Other Info: ``
* URL: http://gm-staging-api:4100/traders
  * Node Name: `http://gm-staging-api:4100/traders ()({type,name,fatherName,phone:[],cnic:[],village,address,openingBalance,openingBalanceType,creditLimit,isActive,notes})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``
* URL: http://gm-staging-api:4100/rates/2026-11-06
  * Node Name: `http://gm-staging-api:4100/rates/2026-11-06 ()({rates:[{commodityId,minRate,maxRate,avgRate,rateUnit}]})`
  * Method: `PUT`
  * Parameter: ``
  * Attack: ``
  * Evidence: `400`
  * Other Info: ``


Instances: 65

### Solution



### Reference



#### CWE Id: [ 388 ](https://cwe.mitre.org/data/definitions/388.html)


#### WASC Id: 20

#### Source ID: 4

### [ Information Disclosure - Sensitive Information in URL ](https://www.zaproxy.org/docs/alerts/10024/)



##### Informational (Medium)

### Description

The request appeared to contain sensitive information leaked in the URL. This can violate PCI and most organizational compliance policies. You can configure the list of strings for this check to add or remove values specific to your environment.

* URL: http://gm-staging-api:4100/admin/tenants/tenantId/audit-logs%3Fpage=1&limit=20&userId=userId&entity=entity&entityId=entityId&action=create&from=from&to=to
  * Node Name: `http://gm-staging-api:4100/admin/tenants/tenantId/audit-logs (action,entity,entityId,from,limit,page,to,userId)`
  * Method: `GET`
  * Parameter: `userId`
  * Attack: ``
  * Evidence: `userId`
  * Other Info: `The URL contains potentially sensitive information. The following string was found via the pattern: user
userId`
* URL: http://gm-staging-api:4100/audit-logs%3Fpage=1&limit=20&userId=userId&entity=entity&entityId=entityId&action=create&from=from&to=to
  * Node Name: `http://gm-staging-api:4100/audit-logs (action,entity,entityId,from,limit,page,to,userId)`
  * Method: `GET`
  * Parameter: `userId`
  * Attack: ``
  * Evidence: `userId`
  * Other Info: `The URL contains potentially sensitive information. The following string was found via the pattern: user
userId`


Instances: 2

### Solution

Do not pass sensitive information in URIs.

### Reference



#### CWE Id: [ 598 ](https://cwe.mitre.org/data/definitions/598.html)


#### WASC Id: 13

#### Source ID: 3

### [ Non-Storable Content ](https://www.zaproxy.org/docs/alerts/10049/)



##### Informational (Medium)

### Description

The response contents are not storable by caching components such as proxy servers. If the response does not contain sensitive, personal or user-specific information, it may benefit from being stored and cached, to improve performance.

* URL: http://gm-staging-api:4100/auth/me
  * Node Name: `http://gm-staging-api:4100/auth/me`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `authorization:`
  * Other Info: ``
* URL: http://gm-staging-api:4100/health
  * Node Name: `http://gm-staging-api:4100/health`
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `authorization:`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/login
  * Node Name: `http://gm-staging-api:4100/auth/login ()({identifier,password,rememberMe})`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `authorization:`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/logout
  * Node Name: `http://gm-staging-api:4100/auth/logout`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `authorization:`
  * Other Info: ``
* URL: http://gm-staging-api:4100/auth/refresh
  * Node Name: `http://gm-staging-api:4100/auth/refresh`
  * Method: `POST`
  * Parameter: ``
  * Attack: ``
  * Evidence: `authorization:`
  * Other Info: ``

Instances: Systemic


### Solution

The content may be marked as storable by ensuring that the following conditions are satisfied:
The request method must be understood by the cache and defined as being cacheable ("GET", "HEAD", and "POST" are currently defined as cacheable)
The response status code must be understood by the cache (one of the 1XX, 2XX, 3XX, 4XX, or 5XX response classes are generally understood)
The "no-store" cache directive must not appear in the request or response header fields
For caching by "shared" caches such as "proxy" caches, the "private" response directive must not appear in the response
For caching by "shared" caches such as "proxy" caches, the "Authorization" header field must not appear in the request, unless the response explicitly allows it (using one of the "must-revalidate", "public", or "s-maxage" Cache-Control response directives)
In addition to the conditions above, at least one of the following conditions must also be satisfied by the response:
It must contain an "Expires" header field
It must contain a "max-age" response directive
For "shared" caches such as "proxy" caches, it must contain a "s-maxage" response directive
It must contain a "Cache Control Extension" that allows it to be cached
It must have a status code that is defined as cacheable by default (200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501).

### Reference


* [ https://datatracker.ietf.org/doc/html/rfc7234 ](https://datatracker.ietf.org/doc/html/rfc7234)
* [ https://datatracker.ietf.org/doc/html/rfc7231 ](https://datatracker.ietf.org/doc/html/rfc7231)
* [ https://www.w3.org/Protocols/rfc2616/rfc2616-sec13.html ](https://www.w3.org/Protocols/rfc2616/rfc2616-sec13.html)


#### CWE Id: [ 524 ](https://cwe.mitre.org/data/definitions/524.html)


#### WASC Id: 13

#### Source ID: 3


